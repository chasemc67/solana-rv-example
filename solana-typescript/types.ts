// Solana SDK Types for Remote Viewing

export interface TargetPool {
  poolId: string;
  address: string;
  creator: string;
  targetCount: number;
  targets: string[]; // Array of image hashes
  createdAt: number;
}

export interface Session {
  sessionId: string;
  poolId: string;
  sessionMediaHash: string;
  submissionSlot: number;
  submissionBlockhash: string; // Base58 format (matches Solana Explorer)
  assignedTargetIndex: number;
  targetSelectorProgram: string;
  submitter: string;
  submittedAt: number;
  finalized: boolean;
  finalizedAt: number;
  completedTargetIndices: number[];
}

export interface CreatePoolResult {
  poolId: string;
  address: string;
  signature: string;
  explorerUrl: string;
}

export interface SubmitSessionResult {
  transactionSignature: string;
  sessionPDA: string;
  submissionSlot: number;
  explorerUrl: string;
}

export interface FinalizeSessionResult {
  transactionSignature: string;
  blockHash: string; // Base58 format (matches Solana Explorer)
  assignedTargetHash: string;
  assignedTargetIndex: number;
  explorerUrl: string;
}

export interface SessionData {
  sessionId: string;
  poolId: string;
  sessionMediaHash: string;
  submissionSlot: number;
  submissionBlockhash: string; // Base58 format (matches Solana Explorer)
  assignedTargetIndex: number;
  targetSelectorProgram: string;
  submitter: string;
  submittedAt: number;
  finalized: boolean;
  finalizedAt: number;
  sessionPDA: string;
  completedTargetIndices: number[];
}

export interface PoolData {
  poolId: string;
  creator: string;
  targetCount: number;
  targets: string[];
  createdAt: number;
  poolPDA: string;
  finalized: boolean;
}

export interface RemoteViewingConfig {
  rpcUrl: string;
  programId: string;
  payerPrivateKey: string;
}
