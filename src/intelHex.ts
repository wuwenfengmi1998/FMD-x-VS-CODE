export interface HexRecord {
    address: number;
    type: number;
    data: number[];
}

export function parseIntelHex(text: string): HexRecord[] {
    const records: HexRecord[] = [];
    let upperAddress = 0;

    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) {
            continue;
        }
        if (!line.startsWith(':')) {
            throw new Error(`无效 Intel HEX 行: ${line}`);
        }

        const bytes: number[] = [];
        for (let i = 1; i < line.length; i += 2) {
            bytes.push(parseInt(line.slice(i, i + 2), 16));
        }

        const count = bytes[0];
        const address = (bytes[1] << 8) | bytes[2];
        const type = bytes[3];
        const data = bytes.slice(4, 4 + count);
        const checksum = bytes[4 + count];
        const sum = bytes.slice(0, 4 + count).reduce((a, b) => a + b, 0);
        if (((sum + checksum) & 0xff) !== 0) {
            throw new Error(`Intel HEX 校验失败: ${line}`);
        }

        if (type === 0x00) {
            records.push({ address: upperAddress + address, type, data });
        } else if (type === 0x01) {
            break;
        } else if (type === 0x04) {
            upperAddress = (((data[0] << 8) | data[1]) << 16) >>> 0;
            records.push({ address, type, data });
        } else {
            records.push({ address: upperAddress + address, type, data });
        }
    }

    return records;
}

export function extractRange(text: string, baseAddress: number, size: number, fill: number): Uint8Array {
    const data = new Uint8Array(size);
    data.fill(fill & 0xff);

    for (const record of parseIntelHex(text)) {
        if (record.type !== 0x00) {
            continue;
        }

        record.data.forEach((value, index) => {
            const address = record.address + index;
            if (address >= baseAddress && address < baseAddress + size) {
                data[address - baseAddress] = value;
            }
        });
    }

    return data;
}

export function writeIntelHex(data: Uint8Array, baseAddress: number, bytesPerLine = 16): string {
    const lines: string[] = [];
    let currentUpper = -1;

    for (let offset = 0; offset < data.length; offset += bytesPerLine) {
        const absolute = baseAddress + offset;
        const upper = absolute >>> 16;
        if (upper !== currentUpper) {
            currentUpper = upper;
            lines.push(makeRecord(0, 0x04, [(upper >> 8) & 0xff, upper & 0xff]));
        }

        const chunk = Array.from(data.slice(offset, offset + bytesPerLine));
        lines.push(makeRecord(absolute & 0xffff, 0x00, chunk));
    }

    lines.push(':00000001FF');
    return lines.join('\r\n') + '\r\n';
}

function makeRecord(address: number, type: number, data: number[]): string {
    const bytes = [
        data.length & 0xff,
        (address >> 8) & 0xff,
        address & 0xff,
        type & 0xff,
        ...data.map(v => v & 0xff),
    ];
    const sum = bytes.reduce((a, b) => a + b, 0);
    const checksum = ((~sum + 1) & 0xff);
    return ':' + [...bytes, checksum].map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('');
}
