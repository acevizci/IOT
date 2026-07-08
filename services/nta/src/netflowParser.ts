export interface FlowRecord {
  srcAddr: string;
  dstAddr: string;
  srcPort: number;
  dstPort: number;
  protocol: number;
  packets: number;
  bytes: number;
}

function ipToString(buf: Buffer, offset: number): string {
  return `${buf[offset]}.${buf[offset + 1]}.${buf[offset + 2]}.${buf[offset + 3]}`;
}

// NetFlow v5: 24 byte header, ardından her biri 48 byte flow record
export function parseNetflowV5(buf: Buffer): FlowRecord[] {
  if (buf.length < 24) return [];

  const version = buf.readUInt16BE(0);
  if (version !== 5) return []; // sadece v5 destekliyoruz

  const count = buf.readUInt16BE(2);
  const records: FlowRecord[] = [];

  const HEADER_SIZE = 24;
  const RECORD_SIZE = 48;

  for (let i = 0; i < count; i++) {
    const offset = HEADER_SIZE + i * RECORD_SIZE;
    if (offset + RECORD_SIZE > buf.length) break;

    records.push({
      srcAddr: ipToString(buf, offset + 0),
      dstAddr: ipToString(buf, offset + 4),
      packets: buf.readUInt32BE(offset + 16),
      bytes: buf.readUInt32BE(offset + 20),
      srcPort: buf.readUInt16BE(offset + 32),
      dstPort: buf.readUInt16BE(offset + 34),
      protocol: buf.readUInt8(offset + 38)
    });
  }

  return records;
}
