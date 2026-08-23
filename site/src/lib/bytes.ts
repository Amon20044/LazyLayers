/**
 * Real bytes, captured from the "Session token" fixture in benchmarks/fixtures.mjs.
 *
 *   JSON.stringify(bentocache envelope) -> 212 bytes
 *   serialize(value)                    -> 123 bytes  (HC1M / msgpack)
 *
 * `KINDS` classifies every character of the JSON document:
 *   s = structural punctuation  {} [] , : "
 *   k = key name
 *   v = value
 * Generated, not hand-typed — see the note in benchmarks/README.md.
 */

export const JSON_DOC = "{\"value\":{\"uid\":\"eb3d0a1b7971473bc9882c2e\",\"sid\":\"97c71aa27740355591bd1c6360deaef8\",\"exp\":1740086400000,\"scopes\":[\"read\",\"write\"],\"ip\":\"10.243.49.222\"},\"createdAt\":1740000000000,\"logicalExpiration\":1740000060000}";

export const KINDS = "skkkkkkksskkkkksvvvvvvvvvvvvvvvvvvvvvvvvvvskkkkksvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvskkkkksvvvvvvvvvvvvvskkkkkkkkssvvvvvvsvvvvvvvsskkkksvvvvvvvvvvvvvvvsskkkkkkkkkkksvvvvvvvvvvvvvskkkkkkkkkkkkkkkkkkksvvvvvvvvvvvvvs";

export const MP_HEX = "4843314dde0005a3756964b8656233643061316237393731343733626339383832633265a3736964d9203937633731616132373734303335353539316264316336333630646561656638a3657870cb42795253b5400000a673636f70657392a472656164a57772697465a26970ad31302e3234332e34392e323232";

/** Byte budget of the JSON document, by what the byte is actually spent on. */
export const BUDGET = {
  structural: 21,
  keys: 64,
  values: 127,
  total: 212,
  binaryTotal: 123,
} as const;
