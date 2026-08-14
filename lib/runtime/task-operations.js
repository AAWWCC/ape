import { GATE_NEXT_MAX_WAIT_MS, GATE_NEXT_POLL_FLOOR_MS } from './constants.js';
import { runtimePaths } from './paths.js';
import { TaskOperationIdSchema } from './schemas.js';
import { sha256 } from './canonical.js';
import {
  collectExpiredTaskOperationTransactions,
  executeTaskOperationTransaction,
  prepareGovernedRuntimeAncestor,
  prepareTaskOperationStore,
  readTaskOperationTransaction,
  TASK_OPERATION_MAX_LIVE_RECORDS,
  taskOperationTransactionPath,
  withReceiptLock,
  writeTaskOperationTransaction,
} from './receipt-service.js';

function now() {
  return new Date().toISOString();
}

export function taskToolError(cause) {
  return { task_tool_error: cause?.message ?? String(cause) };
}

// Both injected callbacks are lock-free service bodies. They are called while
// receipt-effects.lock is held so state binding, the charged NEXT transition,
// and the durable poll journal remain one serialized transaction. Keeping the
// callbacks injected avoids a task-operations -> service import cycle.
export async function executeNextTaskOperation(projectDir, operation, {
  taskOperationRunBindingRefusal,
  nextRunLocked,
}) {
  const paths = runtimePaths(projectDir);
  const operationId = operation.operationId;
  if (!TaskOperationIdSchema.safeParse(operationId).success) {
    throw new Error('task operation requires a valid operationId');
  }
  const inputHash = sha256(JSON.stringify({
    action: operation.action,
    request: operation.request,
    expected_run_id: operation.expectedRunId ?? null,
    preflight_refusal: operation.preflightRefusal ?? null,
  }));
  const transactionFile = taskOperationTransactionPath(paths, operationId);
  await prepareGovernedRuntimeAncestor(paths);
  const requestedWait = operation.request?.wait_ms;
  // A task-created gate crossing keeps polling even when the legacy caller did
  // not request an in-call wait. It remains bounded by the same public maximum.
  const waitMs = Number.isFinite(requestedWait) && requestedWait > 0
    ? Math.min(requestedWait, GATE_NEXT_MAX_WAIT_MS)
    : GATE_NEXT_MAX_WAIT_MS;
  let operationStore = null;
  let collectedExpired = false;
  let retainedTransactions = 0;
  while (true) {
    const step = await withReceiptLock(paths, async () => {
      operationStore ??= await prepareTaskOperationStore(paths);
      if (!collectedExpired) {
        retainedTransactions = await collectExpiredTaskOperationTransactions(paths, operationStore);
        collectedExpired = true;
      }
      let transaction = await readTaskOperationTransaction(transactionFile, operationStore);
      if (transaction && transaction.input_hash !== inputHash) {
        throw new Error(`task operation ${operationId} was replayed with different input`);
      }
      if (transaction?.status === 'effect-committed') {
        return { done: true, result: transaction.result };
      }
      if (transaction?.poll_state === 'polling') {
        const error = Object.assign(
          new Error(`task operation ${operationId} stopped during a gate poll; refusing to rerun an uncertain charged transition`),
          { code: 'APE_TASK_OPERATION_INDETERMINATE' },
        );
        throw error;
      }
      if (!transaction) {
        if (retainedTransactions >= TASK_OPERATION_MAX_LIVE_RECORDS) {
          throw new Error('APE task operation store reached its bounded live-transaction capacity');
        }
        const startedAt = now();
        transaction = await writeTaskOperationTransaction(transactionFile, operationStore, {
          version: 1,
          operation_id: operationId,
          action: operation.action,
          input_hash: inputHash,
          expected_run_id: operation.expectedRunId ?? null,
          status: 'prepared',
          poll_state: 'ready',
          prepared_at: startedAt,
          deadline_at: new Date(Date.parse(startedAt) + waitMs).toISOString(),
        });
      }
      if (operation.isCancelled?.()) {
        const value = taskToolError(new Error('task cancellation requested before gate poll'));
        await writeTaskOperationTransaction(transactionFile, operationStore, {
          ...transaction,
          status: 'effect-committed',
          poll_state: 'ready',
          result: value,
          effect_committed_at: now(),
        });
        return { done: true, result: value };
      }
      if (operation.preflightRefusal) {
        await writeTaskOperationTransaction(transactionFile, operationStore, {
          ...transaction,
          status: 'effect-committed',
          poll_state: 'ready',
          result: operation.preflightRefusal,
          effect_committed_at: now(),
        });
        return { done: true, result: operation.preflightRefusal };
      }
      const bindingRefusal = await taskOperationRunBindingRefusal(paths, operation.expectedRunId);
      if (bindingRefusal) {
        await writeTaskOperationTransaction(transactionFile, operationStore, {
          ...transaction,
          status: 'effect-committed',
          poll_state: 'ready',
          result: bindingRefusal,
          effect_committed_at: now(),
        });
        return { done: true, result: bindingRefusal };
      }
      transaction = await writeTaskOperationTransaction(transactionFile, operationStore, {
        ...transaction,
        poll_state: 'polling',
        poll_started_at: now(),
      });
      let value;
      try {
        value = await nextRunLocked(paths);
      } catch (cause) {
        value = taskToolError(cause);
        await writeTaskOperationTransaction(transactionFile, operationStore, {
          ...transaction,
          status: 'effect-committed',
          poll_state: 'ready',
          result: value,
          effect_committed_at: now(),
        });
        return { done: true, result: value };
      }
      const pending = value.ok && value.actions?.find(
        (entry) => entry.type === 'gating_pending' || entry.type === 'shipping_pending',
      );
      if (!pending || Date.now() >= Date.parse(transaction.deadline_at)) {
        await writeTaskOperationTransaction(transactionFile, operationStore, {
          ...transaction,
          status: 'effect-committed',
          poll_state: 'ready',
          result: value,
          effect_committed_at: now(),
        });
        return { done: true, result: value };
      }
      await writeTaskOperationTransaction(transactionFile, operationStore, {
        ...transaction,
        poll_state: 'ready',
        last_poll_result: value,
        last_poll_committed_at: now(),
      });
      return {
        done: false,
        sleepMs: Math.min(
          Math.max(GATE_NEXT_POLL_FLOOR_MS, pending.retry_after_ms ?? 0),
          Math.max(0, Date.parse(transaction.deadline_at) - Date.now()),
        ),
      };
    }, { busyMessage: 'receipt effects are busy; retry the task gate poll' });
    if (step.done) return step.result;
    if (step.sleepMs > 0) await new Promise((resolve) => setTimeout(resolve, step.sleepMs));
  }
}


export { executeTaskOperationTransaction, withReceiptLock } from './receipt-service.js';
