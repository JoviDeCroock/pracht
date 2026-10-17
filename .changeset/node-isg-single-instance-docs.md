---
"@pracht/cli": patch
"create-pracht": patch
---

The bundled adapter docs and `configure-isg` skill now state that Node ISG pages live on each server, so webhook revalidation reaches only the replica that receives it.
