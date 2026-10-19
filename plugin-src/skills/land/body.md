# APE land

Use when the user explicitly asks to land, apply, or commit the verified patch from a completed APE mission to their working branch without opening a remote GitHub pull request.

1. Ensure the active APE run has completed and passed all verification gates (`ape_status`).
2. Call `ape_run` with `action: "land"`.
   - Automatically prunes ephemeral acceptance traps (`.ape-ephemeral-tests/**`, `*.ephemeral.*`) from the production patch.
   - Applies the patch cleanly to the working checkout.
   - Automatically creates a commit with the mission objective and `Verified-by: APE (<run_id>)` trailer.
3. Report the committed SHA and landed summary to the user.
