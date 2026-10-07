import { canonicalJson, sha256 } from './canonical.js';

export function admissionPageError(code, reason) {
  return { ok: false, advisory: true, blocked: true, code, attempts_consumed: 0, reason };
}

export function validAdmissionPageRequest(page) {
  return page !== null && typeof page === 'object' && !Array.isArray(page)
    && Object.keys(page).length === 2
    && /^[a-f0-9]{64}$/.test(page.digest) && typeof page.digest === 'string'
    && Number.isSafeInteger(page.offset) && page.offset >= 0;
}

// Pure delivery: no cursor store or preview artifact. The caller recomputes the
// full manifest on every read. Transport metadata never enters that manifest.
export function createAdmissionPage(response, request, overBudget) {
  // Start refusals can carry the full internal preview for service consumers.
  // Keep their wire error small; hosts may clip error results more aggressively
  // than successful preview pages. The caller can read a fresh preview instead.
  if (response.ok === false) {
    const code = ['admission-drift', 'admission-not-ready'].includes(response.code)
      ? response.code : 'admission-delivery-invalid';
    return admissionPageError(code, 'Admission was refused. Obtain a fresh preview and review the complete manifest before starting.');
  }
  const manifest = response.admission;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
      || manifest.version !== 1 || typeof manifest.ready !== 'boolean'
      || sha256(manifest) !== response.admission_digest) {
    return admissionPageError('admission-delivery-invalid', 'A complete, hash-consistent admission manifest is required for paged delivery.');
  }
  if (request !== undefined && !validAdmissionPageRequest(request)) {
    return admissionPageError('invalid-admission-page', 'admission_page requires only a manifest digest and a nonnegative integer byte offset.');
  }
  if (request && request.digest !== response.admission_digest) {
    return admissionPageError('admission-drift', 'Admission inputs changed between page reads; obtain a fresh preview and review all pages before starting.');
  }
  const bytes = Buffer.from(canonicalJson(manifest), 'utf8');
  const offset = request?.offset ?? 0;
  if (offset >= bytes.length || (bytes[offset] & 0xc0) === 0x80) {
    return admissionPageError('invalid-admission-page', 'The byte offset must be within the manifest and at a UTF-8 character boundary.');
  }
  const envelope = (end) => {
    const text = bytes.subarray(offset, end).toString('utf8');
    return {
      ok: response.ok, advisory: true,
      ...(response.blocked !== undefined ? { blocked: response.blocked } : {}),
      ...(response.code !== undefined ? { code: response.code } : {}),
      ...(response.attempts_consumed !== undefined ? { attempts_consumed: response.attempts_consumed } : {}),
      admission_summary: { version: manifest.version, ready: manifest.ready },
      admission_delivery: {
        version: 1, kind: 'paged', digest: response.admission_digest,
        total_utf8_bytes: bytes.length, offset,
        next_offset: end === bytes.length ? null : end,
        text, sha256: sha256(text),
      },
    };
  };
  // Search encoded envelopes, including escaped framing and page metadata.
  // Boundary normalization only moves backwards, keeping the search monotone.
  let low = offset + 1;
  let high = bytes.length;
  let best = null;
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    let end = midpoint;
    while (end > offset && (bytes[end] & 0xc0) === 0x80) end -= 1;
    const candidate = envelope(end);
    if (!overBudget(candidate)) {
      if (end > offset) best = candidate;
      low = midpoint + 1;
    } else high = midpoint - 1;
  }
  return best ?? admissionPageError('admission-delivery-invalid', 'The response envelope cannot fit one manifest character within the transport budget.');
}
