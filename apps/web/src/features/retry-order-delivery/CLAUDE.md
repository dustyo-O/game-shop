# `features/retry-order-delivery`

The Retry button on the operator's recovery screen: it `POST`s
`/api/admin/orders/:orderId/retry`, reports what came back, and re-reads the
list afterwards.

Non-obvious, and all argued at length in the file headers:

- **Busy state is per order id, never global.** Two stuck orders can be retried
  at once; disabling the table would serialise the operator behind the slowest
  supplier call.
- **`disabled` is a courtesy, not the protection.** §2.5's fourth criterion is
  two operators on two machines. The guarantee is the order row lock, the
  guarded UPDATE, `deliveries.order_id UNIQUE` and the supplier ledger — remove
  the `disabled` line and nothing changes.
- **An unanswered retry is not a failure.** Transport rejections and `5xx` both
  produce *"may or may not have run — refresh to see"*, because the work happens
  before the response is written.
- **`409` ≠ `200 still_out_of_stock`.** The first says *this order is not
  stuck*; the second says *it is stuck, the retry ran, and it is still stuck*.
  Two answers, two sentences.
- **Notices live in a node the page re-inserts**, not in the row, because every
  outcome re-fetches the list and destroys the row — including the delivered one
  that leaves the list entirely.
