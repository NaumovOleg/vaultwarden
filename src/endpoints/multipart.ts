import { BitwardenError } from "../errors";

// RFC 2046 multipart/form-data parse — no deps, byte-exact (binary payloads
// are base64-decoded by the gateway and must not round-trip through utf-8).
export function parseBodyBytes(contentType: string, body: Buffer): Map<string, Buffer> {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  if (!m) throw new BitwardenError(400, 'Malformed multipart body.');
  const delim = Buffer.from('--' + (m[1] ?? m[2]?.trim()));
  const fields = new Map<string, Buffer>();
  let start = 0;
  for (;;) {
    const partStart = body.indexOf(delim, start);
    if (partStart === -1) break;
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), partStart + delim.length);
    if (headerEnd === -1) break;
    const headers = body.slice(partStart + delim.length, headerEnd).toString('utf-8');
    const name = /name="([^"]+)"/.exec(headers);
    const bodyStart = headerEnd + 4;
    const next = body.indexOf(delim, bodyStart);
    let content = next === -1 ? body.slice(bodyStart) : body.slice(bodyStart, next);
    if (content.length >= 2 && content[content.length - 1] === 10 && content[content.length - 2] === 13) {
      content = content.slice(0, -2);
    }
    if (name) fields.set(name[1], Buffer.from(content));
    if (next === -1) break;
    start = next;
  }
  return fields;
}