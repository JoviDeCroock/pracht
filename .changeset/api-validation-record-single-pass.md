---
"@pracht/framework": patch
---

Group form and query fields in a single pass. `formDataToRecord()` and
`searchParamsToRecord()` walked the unique keys and called `getAll()` for each
one; because `getAll()` rescans the entire entry list, the cost grew
quadratically with the number of distinct fields, so requests carrying many
fields spent a disproportionate amount of time in validation before the handler
ran. Both helpers now build the record in one pass over the entries. Behaviour
is unchanged: a field that appears once maps to its value, a repeated field maps
to an array in submission order, and the record keeps its null prototype.
