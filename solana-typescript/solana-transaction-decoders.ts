// Solana transaction decoder functions
// These can be used in both browser and server environments

// Helper functions for browser-compatible binary data handling
function hexToUint8Array(hex: string): Uint8Array {
  const cleanHex = hex.replace(/^0x/, '');
  const bytes =
    cleanHex.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || [];
  return new Uint8Array(bytes);
}

function readUInt8(buffer: Uint8Array, offset: number): number {
  return buffer[offset];
}

function readUInt32LE(buffer: Uint8Array, offset: number): number {
  return (
    (buffer[offset] |
      (buffer[offset + 1] << 8) |
      (buffer[offset + 2] << 16) |
      (buffer[offset + 3] << 24)) >>>
    0
  ); // Unsigned right shift to ensure positive
}

function uint8ArrayToHex(buffer: Uint8Array): string {
  return Array.from(buffer)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function uint8ArrayToUtf8(buffer: Uint8Array): string {
  return new TextDecoder().decode(buffer);
}

// Instruction decoder functions
export function decodeCreateTargetPoolInstruction(hex: string): {
  instruction: 0;
  pool_id: string;
  target_hashes: string[];
} {
  try {
    const buffer = hexToUint8Array(hex);
    let offset = 0;
    const instruction = readUInt8(buffer, offset) as 0;
    offset += 1;
    // Pool ID (Rust string: 4-byte length prefix, then utf8 bytes)
    const poolIdLen = readUInt32LE(buffer, offset);
    offset += 4;
    const pool_id = uint8ArrayToUtf8(
      buffer.subarray(offset, offset + poolIdLen),
    );
    offset += poolIdLen;
    // Number of hashes (Rust u32)
    const numHashes = readUInt32LE(buffer, offset);
    offset += 4;
    const target_hashes: string[] = [];
    for (let i = 0; i < numHashes; i++) {
      target_hashes.push(uint8ArrayToHex(buffer.subarray(offset, offset + 32)));
      offset += 32;
    }
    return { instruction, pool_id, target_hashes };
  } catch (err: unknown) {
    if (err instanceof Error) {
      throw new Error('Failed to decode CreateTargetPool: ' + err.message);
    }
    throw new Error('Failed to decode CreateTargetPool: Unknown error');
  }
}

export function decodeSubmitSessionInstruction(hex: string): {
  instruction: 1;
  session_id: string;
  pool_id: string;
  session_media_hash: string;
  target_selector_program: string;
} {
  try {
    const buffer = hexToUint8Array(hex);
    let offset = 0;
    const instruction = readUInt8(buffer, offset) as 1;
    offset += 1;
    // Session ID (Rust string: 4-byte length prefix, then utf8 bytes)
    const sessionIdLen = readUInt32LE(buffer, offset);
    offset += 4;
    const session_id = uint8ArrayToUtf8(
      buffer.subarray(offset, offset + sessionIdLen),
    );
    offset += sessionIdLen;
    // Pool ID (Rust string: 4-byte length prefix, then utf8 bytes)
    const poolIdLen = readUInt32LE(buffer, offset);
    offset += 4;
    const pool_id = uint8ArrayToUtf8(
      buffer.subarray(offset, offset + poolIdLen),
    );
    offset += poolIdLen;
    // Session media hash (32 bytes)
    const session_media_hash = uint8ArrayToHex(
      buffer.subarray(offset, offset + 32),
    );
    offset += 32;
    // Target selector program (32 bytes)
    const target_selector_program = uint8ArrayToHex(
      buffer.subarray(offset, offset + 32),
    );
    offset += 32;
    return {
      instruction,
      session_id,
      pool_id,
      session_media_hash,
      target_selector_program,
    };
  } catch (err: unknown) {
    if (err instanceof Error) {
      throw new Error('Failed to decode SubmitSession: ' + err.message);
    }
    throw new Error('Failed to decode SubmitSession: Unknown error');
  }
}

export function decodeFinalizeSessionInstruction(hex: string): {
  instruction: 2;
  session_id: string;
  submission_blockhash: string;
} {
  try {
    const buffer = hexToUint8Array(hex);
    let offset = 0;
    const instruction = readUInt8(buffer, offset) as 2;
    offset += 1;
    // Session ID (Rust string: 4-byte length prefix, then utf8 bytes)
    const sessionIdLen = readUInt32LE(buffer, offset);
    offset += 4;
    const session_id = uint8ArrayToUtf8(
      buffer.subarray(offset, offset + sessionIdLen),
    );
    offset += sessionIdLen;
    // Submission blockhash (now a base58 string: 4-byte length prefix, then utf8 bytes)
    const blockhashLen = readUInt32LE(buffer, offset);
    offset += 4;
    const submission_blockhash = uint8ArrayToUtf8(
      buffer.subarray(offset, offset + blockhashLen),
    );
    offset += blockhashLen;
    return {
      instruction,
      session_id,
      submission_blockhash,
    };
  } catch (err: unknown) {
    if (err instanceof Error) {
      throw new Error('Failed to decode FinalizeSession: ' + err.message);
    }
    throw new Error('Failed to decode FinalizeSession: Unknown error');
  }
}

// Auto-detect instruction type and decode
export function decodeInstruction(hex: string):
  | { instruction: 0; pool_id: string; target_hashes: string[] }
  | {
      instruction: 1;
      session_id: string;
      pool_id: string;
      session_media_hash: string;
      target_selector_program: string;
    }
  | { instruction: 2; session_id: string; submission_blockhash: string } {
  const buffer = hexToUint8Array(hex);
  const instructionByte = readUInt8(buffer, 0);

  if (instructionByte === 0) {
    return decodeCreateTargetPoolInstruction(hex);
  } else if (instructionByte === 1) {
    return decodeSubmitSessionInstruction(hex);
  } else if (instructionByte === 2) {
    return decodeFinalizeSessionInstruction(hex);
  } else {
    throw new Error(`Unknown instruction type: ${instructionByte}`);
  }
}
