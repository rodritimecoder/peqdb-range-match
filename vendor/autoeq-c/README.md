# autoeq-c (vendored)

Upstream: https://github.com/peqdb/autoeq-c

Commit: `fdc0db772164387c2df8739742594197c6851fc3` (`ts -> js`)

License: LGPL-3.0-or-later, see `LICENSE`.

This is the C source only, used by the optional **Real AutoEQ** overlay. It is
compiled into a separate native executable by `tools/build-autoeq.mjs`; the
binary is not committed.

Local patches:

- the upstream `exp10()` static inline is renamed to `exp10f_()` because
  glibc's `math.h` already declares `exp10()`, which makes the upstream source
  fail to compile on Linux.
- the native CLI prints `mean + amp` instead of `amp`, matching the upstream
  JavaScript wrapper (`example/autoeq.js`). The native CLI otherwise drops the
  demean offset, so the corrected curve is shifted by the mean.

No algorithm or numerical behaviour changed.
