/**
 * The supplier's key pool — fifty codes, **verbatim from the assignment**.
 *
 * A fixed input like the catalogue (technical-considerations §3, "System
 * Dependencies"), transcribed in the brief's own order so this file can be
 * diffed against it directly.
 *
 * ---------------------------------------------------------------------------
 * THIS IS SUPPLIER-SIDE INVENTORY. SHOP CODE MUST NOT IMPORT IT.
 * ---------------------------------------------------------------------------
 * Same rule, and the same reason, as `../schema/supplier.ts`: the shop learns a
 * code only by asking the supplier over HTTP and then writing a `deliveries` row
 * of its own. A shop module that imported this list would know the pool without
 * having crossed that boundary, and every later phase — supplier timeouts, the
 * same-`request_id` retry trap, the fallback to supplier B — only demonstrates
 * anything because the shop's knowledge is limited to what came back over the
 * wire. The legitimate consumers are `../seed.ts`, which loads the pool, and
 * tests that need to know how large it is before draining it.
 *
 * The pool is loaded unclaimed (`claimed_by_request_id` NULL). There is no
 * "unclaim": re-running the seed adds missing codes and never touches a row that
 * already exists — see the `ON CONFLICT (code) DO NOTHING` in `../seed.ts`.
 */
export const supplierKeyPool = [
  "LFXC-TNCS-BPCD",
  "P3EI-W8UO-9B4K",
  "FEL3-GUXN-TCCH",
  "YPLV-QK2Z-IUS5",
  "0K9E-P1FR-BY1U",
  "5LZV-UQ48-RXCZ",
  "X93K-NYAQ-GEC1",
  "EIO5-CQT5-35KO",
  "M58F-GIIR-VJAP",
  "NU8Y-SWYB-6252",
  "OODW-CCHF-MBAF",
  "DNA5-WFJM-NE49",
  "QRDD-MJ3F-A8TF",
  "TAT9-5ZJN-G1T2",
  "LI39-4330-ISMB",
  "BKJY-8Q79-8NHI",
  "HHW6-4RX2-DX62",
  "1RG2-L28O-O80G",
  "EF63-F39X-MTEA",
  "8XS7-P53H-JKIV",
  "JPE6-MQV6-P7ST",
  "SAPG-A2GR-0ULS",
  "T2DU-IJ1S-U16P",
  "WSSY-QTR7-Z57J",
  "U74E-EPCI-CY26",
  "FZXF-58H8-OR93",
  "FPSM-HLZA-TPAL",
  "WSC9-28DJ-B2JE",
  "P63J-F7UZ-DCYP",
  "C7W2-D4C5-QMT7",
  "JESI-DFBH-LK1K",
  "SGMA-JA0T-GR7D",
  "3PR4-OSY9-M3ZW",
  "OMBE-C0JF-D45Y",
  "KIKQ-FQJ8-9TI8",
  "LMAN-RSHS-AJDO",
  "BAKI-VT1X-Z5OL",
  "9F0X-B46W-03FS",
  "S423-V6YY-IBEM",
  "D4UW-WYRA-20ST",
  "XC0J-CJ0H-09RN",
  "RY1W-XCFJ-0KUA",
  "CJYY-YKSQ-QE6H",
  "97AQ-38QJ-H8HU",
  "FS8E-3S5Z-I6RA",
  "ARQK-FML4-A14E",
  "7Z6K-NO9V-MPJB",
  "D4K7-IJSG-N853",
  "W67T-ZB0Q-1XKB",
  "7EQM-K09J-XKUO",
] as const satisfies readonly string[];

/**
 * Fifty. The `out_of_stock` scenario is produced by claiming this many keys, so
 * a test that drains the pool should count from here rather than hard-code it.
 */
export const SUPPLIER_KEY_POOL_SIZE = supplierKeyPool.length;
