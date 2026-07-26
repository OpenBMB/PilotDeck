# V24R5 QA Evidence

## What Was Tested

- The focused Legal Coverage suite exercised source proposal creation,
  structured rejection, bounded `repairSlice` injection, fallback rejection,
  convergence stability, direct apply rejection, and atomic valid apply.
- The full repository suite covered unchanged Core, O1, Progress Lease,
  routing, memory, other products, and adapter behavior.
- Real local Gateway integration tests drove the built Gateway and project
  hooks through artifact correction and completion blocking.
- A disposable replay copied the exact retained V24R4 Case 09 failure workspace,
  overlaid only the V24R5 Legal Coverage plugin, invoked the real
  `PreModelRequest` hook, and then applied the one supported counterfactual
  repair with the real Legal Coverage CLI.

Reproducible commands and the sanitized replay result are recorded alongside
this file. No closed campaign directory was restarted or modified.

## What Was Observed

- Build: passed with Node 22 and pnpm 10.32.1.
- Focused Legal Coverage: 39 passed, 0 failed.
- Full repository: 282 passed, 0 failed.
- Real local Gateway integration: 3 passed, 0 failed.
- The exact Case 09 failure replay returned one locator diagnostic with
  `factNumber: 11`, the exact rejected fact, and one referenced source context
  containing 7 allowed locators, 1 conflict, and 1 unresolved item.
- The complete rejected proposal contained 16 facts and 13,416 bytes. The
  injected repair slice serialized to 13,310 bytes within its explicit bound.
- Removing only unsupported fact 11 and invoking the real V24R5 apply command
  succeeded atomically with 4 sources and 15 facts, advancing the disposable
  copy from 16 reviewed sources / 71 facts to 20 reviewed sources / 86 facts.
- The original retained campaign proposal hash was unchanged after replay.

## Why This Is Enough

The synthetic counterexamples prove contract behavior across multiple rejected
proposal shapes, including the no-diagnostics fallback and invalid-revision
hash stability. The exact failure replay proves that the domain-owned slice
contains the information missing in the live 349-line Case 09 trajectory and
that following its bounded omit-versus-replace instruction clears the only
validator blocker for that transaction. Gateway and full-suite gates cover the
broader loading and regression surface.

This is enough to commit V24R5 and authorize a fresh immutable small campaign.
It is not evidence that the model will complete Case 09 end to end; that remains
the product Gate before V25 or an 85-case run.

## What Was Omitted

- No API key, authorization header, provider configuration, environment dump,
  raw model request, or secret-bearing log was captured.
- Private source text and the complete rejected legal proposal are not copied
  into versioned evidence. Only aggregate counts and stable error codes remain.
- The previous closed campaign and its retained workspace were read-only. All
  mutations occurred in a generated temporary copy that was deleted after the
  replay.
