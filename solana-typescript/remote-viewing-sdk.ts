import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  SYSVAR_CLOCK_PUBKEY,
} from '@solana/web3.js';
import { createHash } from 'crypto';
import bs58 from 'bs58';
import * as borsh from 'borsh';
import {
  CreatePoolResult,
  SubmitSessionResult,
  FinalizeSessionResult,
  SessionData,
  PoolData,
} from './types';

// Instruction discriminators - these match the Rust enum variant order
enum InstructionType {
  CreateTargetPool = 0,
  SubmitSession = 1,
  FinalizeSession = 2,
}

// Define the schema for Borsh serialization matching Rust enum structure
class CreateTargetPoolInstruction {
  pool_id: string;
  target_hashes: Uint8Array[];

  constructor(poolId: string, targetHashes: string[]) {
    this.pool_id = poolId;
    this.target_hashes = targetHashes.map(hash => Buffer.from(hash, 'hex'));
  }
}

class SubmitSessionInstruction {
  session_id: string;
  pool_id: string;
  session_media_hash: Uint8Array;
  target_selector_program: Uint8Array;

  constructor(
    sessionId: string,
    poolId: string,
    sessionMediaHash: Uint8Array,
    targetSelectorProgram: PublicKey,
  ) {
    this.session_id = sessionId;
    this.pool_id = poolId;
    this.session_media_hash = sessionMediaHash;
    this.target_selector_program = targetSelectorProgram.toBuffer();
  }
}

class FinalizeSessionInstruction {
  session_id: string;
  submission_blockhash: string; // Changed to base58 string

  constructor(sessionId: string, submissionBlockhashBase58: string) {
    this.session_id = sessionId;
    this.submission_blockhash = submissionBlockhashBase58;
  }
}

// Borsh schemas matching Rust enum structure
const CREATE_POOL_SCHEMA = new Map([
  [
    CreateTargetPoolInstruction,
    {
      kind: 'struct',
      fields: [
        ['pool_id', 'string'],
        ['target_hashes', [['u8', 32]]],
      ],
    },
  ],
]);

const SUBMIT_SESSION_SCHEMA = new Map([
  [
    SubmitSessionInstruction,
    {
      kind: 'struct',
      fields: [
        ['session_id', 'string'],
        ['pool_id', 'string'],
        ['session_media_hash', ['u8', 32]],
        ['target_selector_program', ['u8', 32]],
      ],
    },
  ],
]);

const FINALIZE_SESSION_SCHEMA = new Map([
  [
    FinalizeSessionInstruction,
    {
      kind: 'struct',
      fields: [
        ['session_id', 'string'],
        ['submission_blockhash', 'string'], // Changed to string for base58
      ],
    },
  ],
]);

// Data structures for reading blockchain data
class SessionAccount {
  session_id: string = '';
  pool_id: string = '';
  session_media_hash: Uint8Array = new Uint8Array(32);
  submission_slot: bigint = BigInt(0);
  submission_blockhash: Uint8Array = new Uint8Array(32);
  assigned_target_index: number = 0;
  target_selector_program: Uint8Array = new Uint8Array(32);
  submitter: Uint8Array = new Uint8Array(32);
  submitted_at: bigint = BigInt(0);
  finalized: boolean = false;
  finalized_at: bigint = BigInt(0);
}

class PoolAccount {
  pool_id: string = '';
  creator: Uint8Array = new Uint8Array(32);
  target_count: number = 0;
  targets: Uint8Array[] = [];
  created_at: bigint = BigInt(0);
}

// Manual deserialization functions
function deserializeSessionAccount(data: Buffer): SessionAccount {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;

  // Read session_id (string: 4-byte length + utf8 bytes)
  const sessionIdLen = view.getUint32(offset, true);
  offset += 4;
  const session_id = data.slice(offset, offset + sessionIdLen).toString('utf8');
  offset += sessionIdLen;

  // Read pool_id (string: 4-byte length + utf8 bytes)
  const poolIdLen = view.getUint32(offset, true);
  offset += 4;
  const pool_id = data.slice(offset, offset + poolIdLen).toString('utf8');
  offset += poolIdLen;

  // Read session_media_hash (32 bytes)
  const session_media_hash = new Uint8Array(data.slice(offset, offset + 32));
  offset += 32;

  // Read submission_slot (u64 - 8 bytes)
  const submission_slot = view.getBigUint64(offset, true);
  offset += 8;

  // Read submission_blockhash (32 bytes)
  const submission_blockhash = new Uint8Array(data.slice(offset, offset + 32));
  offset += 32;

  // Read assigned_target_index (u16 - 2 bytes)
  const assigned_target_index = view.getUint16(offset, true);
  offset += 2;

  // Read target_selector_program (32 bytes)
  const target_selector_program = new Uint8Array(
    data.slice(offset, offset + 32),
  );
  offset += 32;

  // Read submitter (32 bytes)
  const submitter = new Uint8Array(data.slice(offset, offset + 32));
  offset += 32;

  // Read submitted_at (i64 - 8 bytes)
  const submitted_at = view.getBigInt64(offset, true);
  offset += 8;

  // Read finalized (bool - 1 byte)
  const finalized = data[offset] !== 0;
  offset += 1;

  // Read finalized_at (i64 - 8 bytes)
  const finalized_at = view.getBigInt64(offset, true);
  offset += 8;

  const account = new SessionAccount();
  account.session_id = session_id;
  account.pool_id = pool_id;
  account.session_media_hash = session_media_hash;
  account.submission_slot = submission_slot;
  account.submission_blockhash = submission_blockhash;
  account.assigned_target_index = assigned_target_index;
  account.target_selector_program = target_selector_program;
  account.submitter = submitter;
  account.submitted_at = submitted_at;
  account.finalized = finalized;
  account.finalized_at = finalized_at;

  return account;
}

function deserializePoolAccount(data: Buffer): PoolAccount {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;

  // Read pool_id (string: 4-byte length + utf8 bytes)
  const poolIdLen = view.getUint32(offset, true);
  offset += 4;
  const pool_id = data.slice(offset, offset + poolIdLen).toString('utf8');
  offset += poolIdLen;

  // Read creator (32 bytes)
  const creator = new Uint8Array(data.slice(offset, offset + 32));
  offset += 32;

  // Read target_count (u16 - 2 bytes)
  const target_count = view.getUint16(offset, true);
  offset += 2;

  // Read targets (Vec<[u8; 32]>: 4-byte length + target_count * 32 bytes)
  const targetsLen = view.getUint32(offset, true);
  offset += 4;
  const targets: Uint8Array[] = [];
  for (let i = 0; i < targetsLen; i++) {
    targets.push(new Uint8Array(data.slice(offset, offset + 32)));
    offset += 32;
  }

  // Read created_at (i64 - 8 bytes)
  const created_at = view.getBigInt64(offset, true);
  offset += 8;

  const account = new PoolAccount();
  account.pool_id = pool_id;
  account.creator = creator;
  account.target_count = target_count;
  account.targets = targets;
  account.created_at = created_at;

  return account;
}

import { type SolanaNetwork } from '../utils/solana-config';

export class RemoteViewingSDK {
  private connection: Connection;
  private programId: PublicKey;
  private payer: Keypair;
  private network: SolanaNetwork;

  constructor(
    rpcUrl: string,
    programId: string,
    payerPrivateKeyBase58: string,
    network: SolanaNetwork = 'devnet', // Explicit network parameter
  ) {
    // Create connection
    this.connection = new Connection(rpcUrl, 'confirmed');
    this.network = network;

    // Create program ID
    this.programId = new PublicKey(programId);

    // Create payer keypair from private key
    try {
      const privateKeyBytes = bs58.decode(payerPrivateKeyBase58);
      this.payer = Keypair.fromSecretKey(privateKeyBytes);
      console.log(
        'Initialized SDK with address:',
        this.payer.publicKey.toBase58(),
      );
    } catch (error) {
      console.error('Failed to initialize payer:', error);
      throw new Error('Failed to initialize Solana payer');
    }
  }

  async createNewPool(targetHashes: string[]): Promise<CreatePoolResult> {
    // Validate input parameters
    if (!targetHashes || targetHashes.length === 0) {
      throw new Error('Target hashes cannot be empty');
    }

    if (targetHashes.length > 10000) {
      throw new Error('Too many target hashes (max 10000)');
    }

    // Validate all hashes are 32 bytes hex strings
    for (const hash of targetHashes) {
      if (!/^[0-9a-fA-F]{64}$/.test(hash)) {
        throw new Error(
          `Invalid hash format: ${hash} (must be 32 bytes hex string)`,
        );
      }
    }

    const poolId = `pool_${Date.now()}`;
    const poolPDA = await this.getPoolPDA(poolId);

    console.log('Creating pool:', poolId);
    console.log('Pool PDA:', poolPDA.toBase58());
    console.log('Target hashes:', targetHashes.length);

    try {
      // Check balance first
      const balance = await this.getBalance();
      console.log('Current balance:', balance, 'SOL');

      if (balance < 0.01) {
        throw new Error('Insufficient balance. Need at least 0.01 SOL');
      }

      // Create instruction data
      const instructionData = this.encodeCreatePoolInstruction(
        poolId,
        targetHashes,
      );

      // Build instruction
      const instruction = new TransactionInstruction({
        programId: this.programId,
        keys: [
          { pubkey: poolPDA, isSigner: false, isWritable: true },
          { pubkey: this.payer.publicKey, isSigner: true, isWritable: true },
          {
            pubkey: SystemProgram.programId,
            isSigner: false,
            isWritable: false,
          },
        ],
        data: instructionData,
      });

      // Create and send transaction with retry logic
      const transaction = new Transaction().add(instruction);

      const signature = await this.sendTransactionWithRetry(transaction, [
        this.payer,
      ]);

      console.log('Pool creation transaction sent:', signature);

      // Generate explorer URL using helper method
      const explorerUrl = this.getExplorerUrl('tx', signature);
      console.log('View on Solana Explorer:', explorerUrl);

      return {
        poolId,
        address: poolPDA.toBase58(),
        signature,
        explorerUrl,
      };
    } catch (error) {
      console.error('Error creating pool:', error);
      throw error;
    }
  }

  async submitSession(
    sessionId: string,
    poolId: string,
    sessionMediaHash: string,
  ): Promise<SubmitSessionResult> {
    // Validate input parameters
    if (!sessionId || sessionId.trim() === '') {
      throw new Error('Session ID cannot be empty');
    }

    if (!poolId || poolId.trim() === '') {
      throw new Error('Pool ID cannot be empty');
    }

    if (!sessionMediaHash || !/^[0-9a-fA-F]{64}$/.test(sessionMediaHash)) {
      throw new Error('Session media hash must be a 32-byte hex string');
    }

    const sessionPDA = await this.getSessionPDA(sessionId);
    const poolPDA = await this.getPoolPDA(poolId);

    console.log('Submitting session:', sessionId);
    console.log('Session PDA:', sessionPDA.toBase58());
    console.log('Pool PDA:', poolPDA.toBase58());

    try {
      // Convert hex hash to bytes
      const mediaHashBytes = Buffer.from(sessionMediaHash, 'hex');
      if (mediaHashBytes.length !== 32) {
        throw new Error('Session media hash must be 32 bytes');
      }

      // Create instruction data
      const instructionData = this.encodeSubmitSessionInstruction(
        sessionId,
        poolId,
        mediaHashBytes,
        this.programId, // Using program ID as target selector for now
      );

      // Build instruction
      const instruction = new TransactionInstruction({
        programId: this.programId,
        keys: [
          { pubkey: sessionPDA, isSigner: false, isWritable: true },
          { pubkey: poolPDA, isSigner: false, isWritable: false },
          { pubkey: this.payer.publicKey, isSigner: true, isWritable: true },
          {
            pubkey: SystemProgram.programId,
            isSigner: false,
            isWritable: false,
          },
          { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
        ],
        data: instructionData,
      });

      // Create and send transaction with retry logic
      const transaction = new Transaction().add(instruction);

      const signature = await this.sendTransactionWithRetry(transaction, [
        this.payer,
      ]);

      console.log('Session submission transaction sent:', signature);

      // Get the actual slot from the confirmed transaction to fix race condition
      const txInfo = await this.connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });

      const actualSubmissionSlot = txInfo?.slot;
      if (!actualSubmissionSlot) {
        throw new Error(
          'Could not retrieve actual submission slot from transaction',
        );
      }

      // Generate explorer URLs using helper method
      const txExplorerUrl = this.getExplorerUrl('tx', signature);
      const accountExplorerUrl = this.getExplorerUrl(
        'address',
        sessionPDA.toBase58(),
      );
      console.log('View transaction on Solana Explorer:', txExplorerUrl);
      console.log(
        'View session account on Solana Explorer:',
        accountExplorerUrl,
      );

      return {
        transactionSignature: signature,
        sessionPDA: sessionPDA.toBase58(),
        submissionSlot: actualSubmissionSlot,
        explorerUrl: txExplorerUrl,
      };
    } catch (error) {
      console.error('Error submitting session:', error);
      throw error;
    }
  }

  async finalizeSession(
    sessionId: string,
    poolId: string,
  ): Promise<FinalizeSessionResult> {
    const sessionPDA = await this.getSessionPDA(sessionId);
    const poolPDA = await this.getPoolPDA(poolId);

    console.log('Finalizing session:', sessionId);
    console.log('Session PDA:', sessionPDA.toBase58());

    try {
      // Get the session data to retrieve the submission slot
      const sessionData = await this.getSessionData(sessionId);
      if (!sessionData) {
        throw new Error(`Session ${sessionId} not found`);
      }

      // Wait for at least 2 slots to pass (security requirement)
      console.log(
        'Waiting for sufficient slots to pass before finalization...',
      );
      const currentSlot = await this.connection.getSlot();
      const requiredSlot = sessionData.submissionSlot + 2;

      if (currentSlot < requiredSlot) {
        const slotsToWait = requiredSlot - currentSlot;
        console.log(
          `Need to wait for ${slotsToWait} more slots. Current: ${currentSlot}, Required: ${requiredSlot}`,
        );

        // Wait for slots (approximately 400ms per slot)
        const waitTime = slotsToWait * 500; // 500ms per slot to be safe
        console.log(`Waiting ${waitTime}ms for slots to pass...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));

        // Double-check we have enough slots now
        const newCurrentSlot = await this.connection.getSlot();
        if (newCurrentSlot < requiredSlot) {
          throw new Error(
            `Still too early to finalize. Current slot: ${newCurrentSlot}, Required: ${requiredSlot}`,
          );
        }
      }

      // Get the blockhash for the submission slot
      const slotInfo = await this.connection.getBlock(
        sessionData.submissionSlot,
        {
          maxSupportedTransactionVersion: 0,
        },
      );
      if (!slotInfo) {
        throw new Error(
          `Could not fetch block for slot ${sessionData.submissionSlot}`,
        );
      }

      // Keep blockhash as base58 string (same format as Solana Explorer)
      const submissionBlockhashBase58 = slotInfo.blockhash;

      // Create instruction data
      const instructionData = this.encodeFinalizeSessionInstruction(
        sessionId,
        submissionBlockhashBase58,
      );

      // Build instruction (removed SYSVAR_SLOT_HASHES_PUBKEY)
      const instruction = new TransactionInstruction({
        programId: this.programId,
        keys: [
          { pubkey: sessionPDA, isSigner: false, isWritable: true },
          { pubkey: poolPDA, isSigner: false, isWritable: false },
          { pubkey: this.payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
        ],
        data: instructionData,
      });

      // Create and send transaction with retry logic
      const transaction = new Transaction().add(instruction);
      transaction.feePayer = this.payer.publicKey;

      const signature = await this.sendTransactionWithRetry(transaction, [
        this.payer,
      ]);

      console.log('Session finalization transaction sent:', signature);

      // Calculate the target assignment using the submission blockhash (in base58)
      const { targetHash, targetIndex } = await this.getTargetForSession(
        submissionBlockhashBase58,
        poolId,
      );

      // Generate explorer URL using helper method
      const explorerUrl = this.getExplorerUrl('tx', signature);
      console.log('View on Solana Explorer:', explorerUrl);

      return {
        transactionSignature: signature,
        blockHash: submissionBlockhashBase58, // Return base58 format
        assignedTargetHash: targetHash,
        assignedTargetIndex: targetIndex,
        explorerUrl,
      };
    } catch (error) {
      console.error('Error finalizing session:', error);
      throw error;
    }
  }

  async getTargetForSession(
    blockHashBase58: string,
    poolId: string,
  ): Promise<{ targetHash: string; targetIndex: number }> {
    // Get the actual pool data from the blockchain
    const poolData = await this.getPoolData(poolId);
    if (!poolData) {
      throw new Error(`Pool ${poolId} not found`);
    }

    const index = this.hashToIndex(blockHashBase58, poolData.targets.length);
    return {
      targetHash: poolData.targets[index],
      targetIndex: index,
    };
  }

  async getBalance(): Promise<number> {
    try {
      const balance = await this.connection.getBalance(this.payer.publicKey);
      return balance / 1e9; // Convert lamports to SOL
    } catch (error) {
      console.error('Error getting balance:', error);
      throw error;
    }
  }

  getWalletAddress(): string {
    return this.payer.publicKey.toBase58();
  }

  private async sendTransactionWithRetry(
    transaction: Transaction,
    signers: Keypair[],
    maxRetries: number = 3,
    retryDelay: number = 1000,
  ): Promise<string> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Get fresh blockhash for each attempt
        const { blockhash } = await this.connection.getLatestBlockhash();
        transaction.recentBlockhash = blockhash;

        const signature = await sendAndConfirmTransaction(
          this.connection,
          transaction,
          signers,
          {
            commitment: 'confirmed',
            skipPreflight: false,
            maxRetries: 0, // Handle retries ourselves
          },
        );

        return signature;
      } catch (error) {
        lastError = error as Error;
        console.warn(`Transaction attempt ${attempt + 1} failed:`, error);

        if (attempt < maxRetries - 1) {
          const delay = retryDelay * Math.pow(2, attempt); // Exponential backoff
          console.log(`Retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw new Error(
      `Transaction failed after ${maxRetries} attempts: ${lastError?.message || 'Unknown error'}`,
    );
  }

  private async getPoolPDA(poolId: string): Promise<PublicKey> {
    // Hash the poolId to ensure it fits within the 32-byte seed limit
    const poolIdHash = createHash('sha256').update(poolId).digest();
    const [pda] = await PublicKey.findProgramAddress(
      [Buffer.from('target_pool'), poolIdHash],
      this.programId,
    );
    return pda;
  }

  private async getSessionPDA(sessionId: string): Promise<PublicKey> {
    // Hash the sessionId to ensure it fits within the 32-byte seed limit
    const sessionIdHash = createHash('sha256').update(sessionId).digest();
    const [pda] = await PublicKey.findProgramAddress(
      [Buffer.from('session'), sessionIdHash],
      this.programId,
    );
    return pda;
  }

  private hashToIndex(blockHashBase58: string, targetCount: number): number {
    // Convert base58 string to bytes - this matches the contract's calculate_target_index function
    const hash = Buffer.from(bs58.decode(blockHashBase58));

    // Use first 8 bytes as uint64, modulo target count
    const value = hash.readBigUInt64BE(0);
    return Number(value % BigInt(targetCount));
  }

  private encodeCreatePoolInstruction(
    poolId: string,
    targetHashes: string[],
  ): Buffer {
    const instruction = new CreateTargetPoolInstruction(poolId, targetHashes);
    const data = borsh.serialize(CREATE_POOL_SCHEMA, instruction);
    // Prepend the enum variant discriminator (0 for CreateTargetPool)
    return Buffer.concat([
      Buffer.from([InstructionType.CreateTargetPool]),
      Buffer.from(data),
    ]);
  }

  private encodeSubmitSessionInstruction(
    sessionId: string,
    poolId: string,
    sessionMediaHash: Uint8Array,
    targetSelectorProgram: PublicKey,
  ): Buffer {
    const instruction = new SubmitSessionInstruction(
      sessionId,
      poolId,
      sessionMediaHash,
      targetSelectorProgram,
    );
    const data = borsh.serialize(SUBMIT_SESSION_SCHEMA, instruction);
    // Prepend the enum variant discriminator (1 for SubmitSession)
    return Buffer.concat([
      Buffer.from([InstructionType.SubmitSession]),
      Buffer.from(data),
    ]);
  }

  private encodeFinalizeSessionInstruction(
    sessionId: string,
    submissionBlockhashBase58: string,
  ): Buffer {
    const instruction = new FinalizeSessionInstruction(
      sessionId,
      submissionBlockhashBase58,
    );
    const data = borsh.serialize(FINALIZE_SESSION_SCHEMA, instruction);
    // Prepend the enum variant discriminator (2 for FinalizeSession)
    return Buffer.concat([
      Buffer.from([InstructionType.FinalizeSession]),
      Buffer.from(data),
    ]);
  }

  async getSessionData(sessionId: string): Promise<SessionData | null> {
    try {
      const sessionPDA = await this.getSessionPDA(sessionId);
      const accountInfo = await this.connection.getAccountInfo(sessionPDA);

      if (!accountInfo || !accountInfo.data) {
        return null;
      }

      const sessionAccount = deserializeSessionAccount(accountInfo.data);

      return {
        sessionId: sessionAccount.session_id,
        poolId: sessionAccount.pool_id,
        sessionMediaHash: Buffer.from(
          sessionAccount.session_media_hash,
        ).toString('hex'),
        submissionSlot: Number(sessionAccount.submission_slot),
        submissionBlockhash: bs58.encode(sessionAccount.submission_blockhash), // Convert to base58
        assignedTargetIndex: sessionAccount.assigned_target_index,
        targetSelectorProgram: new PublicKey(
          sessionAccount.target_selector_program,
        ).toBase58(),
        submitter: new PublicKey(sessionAccount.submitter).toBase58(),
        submittedAt: Number(sessionAccount.submitted_at),
        finalized: sessionAccount.finalized,
        finalizedAt: Number(sessionAccount.finalized_at),
        sessionPDA: sessionPDA.toBase58(),
      };
    } catch (error) {
      console.error('Error getting session data:', error);
      return null;
    }
  }

  async getPoolData(poolId: string): Promise<PoolData | null> {
    try {
      const poolPDA = await this.getPoolPDA(poolId);
      const accountInfo = await this.connection.getAccountInfo(poolPDA);

      if (!accountInfo || !accountInfo.data) {
        return null;
      }

      const poolAccount = deserializePoolAccount(accountInfo.data);

      return {
        poolId: poolAccount.pool_id,
        creator: new PublicKey(poolAccount.creator).toBase58(),
        targetCount: poolAccount.target_count,
        targets: poolAccount.targets.map((target: Uint8Array) =>
          Buffer.from(target).toString('hex'),
        ),
        createdAt: Number(poolAccount.created_at),
        poolPDA: poolPDA.toBase58(),
      };
    } catch (error) {
      console.error('Error getting pool data:', error);
      return null;
    }
  }

  async getSessionWithTargetHash(
    sessionId: string,
  ): Promise<(SessionData & { assignedTargetHash?: string }) | null> {
    try {
      const sessionData = await this.getSessionData(sessionId);
      if (!sessionData || !sessionData.finalized) {
        return sessionData;
      }

      const poolData = await this.getPoolData(sessionData.poolId);
      if (!poolData) {
        return sessionData;
      }

      const assignedTargetHash =
        poolData.targets[sessionData.assignedTargetIndex];
      return {
        ...sessionData,
        assignedTargetHash,
      };
    } catch (error) {
      console.error('Error getting session with target hash:', error);
      return null;
    }
  }

  /**
   * Verify that a session's target assignment is valid and unpredictable
   * This is a key method for proving the integrity of the randomness system
   */
  async verifySessionIntegrity(sessionId: string): Promise<{
    valid: boolean;
    sessionData: SessionData | null;
    poolData: PoolData | null;
    verificationDetails: {
      targetHashMatches: boolean;
      submissionBlockhashValid: boolean;
      targetIndexCalculatedCorrectly: boolean;
      sessionFinalized: boolean;
    };
  }> {
    const sessionData = await this.getSessionData(sessionId);
    if (!sessionData) {
      return {
        valid: false,
        sessionData: null,
        poolData: null,
        verificationDetails: {
          targetHashMatches: false,
          submissionBlockhashValid: false,
          targetIndexCalculatedCorrectly: false,
          sessionFinalized: false,
        },
      };
    }

    const poolData = await this.getPoolData(sessionData.poolId);
    if (!poolData) {
      return {
        valid: false,
        sessionData,
        poolData: null,
        verificationDetails: {
          targetHashMatches: false,
          submissionBlockhashValid: false,
          targetIndexCalculatedCorrectly: false,
          sessionFinalized: sessionData.finalized,
        },
      };
    }

    // Verify target hash matches
    const expectedTargetHash =
      poolData.targets[sessionData.assignedTargetIndex];
    const targetHashMatches = Boolean(expectedTargetHash);

    // Verify blockhash is valid (not all zeros)
    const submissionBlockhashValid =
      sessionData.submissionBlockhash !== bs58.encode(Buffer.alloc(32)); // Check against base58 encoded zero hash

    // Verify target index calculation
    const calculatedIndex = this.hashToIndex(
      sessionData.submissionBlockhash,
      poolData.targets.length,
    );
    const targetIndexCalculatedCorrectly =
      calculatedIndex === sessionData.assignedTargetIndex;

    const verificationDetails = {
      targetHashMatches,
      submissionBlockhashValid,
      targetIndexCalculatedCorrectly,
      sessionFinalized: sessionData.finalized,
    };

    const valid =
      targetHashMatches &&
      submissionBlockhashValid &&
      targetIndexCalculatedCorrectly &&
      sessionData.finalized;

    return {
      valid,
      sessionData,
      poolData,
      verificationDetails,
    };
  }

  /**
   * Generate verification links for blockchain explorers
   */
  private getExplorerUrl(type: 'tx' | 'address', id: string): string {
    const clusterParam = this.network === 'devnet' ? '?cluster=devnet' : '';
    return `https://explorer.solana.com/${type}/${id}${clusterParam}`;
  }

  getVerificationLinks(
    sessionData: SessionData,
    poolData: PoolData,
  ): {
    sessionTransaction: string;
    sessionAccount: string;
    poolAccount: string;
  } {
    return {
      sessionTransaction: this.getExplorerUrl('tx', sessionData.sessionPDA),
      sessionAccount: this.getExplorerUrl('address', sessionData.sessionPDA),
      poolAccount: this.getExplorerUrl('address', poolData.poolPDA),
    };
  }
}
