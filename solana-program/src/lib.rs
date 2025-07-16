use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    msg,
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
    clock::Clock,
    slot_history::Slot,
    hash::hash,
};

// Define the program ID - this will be replaced with the actual program ID after deployment
solana_program::declare_id!("AgdxtGStJsyCZAZvZChtnTtaK774e3Yf2QWdq8gSfLuc");

// Program instructions
#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub enum RemoteViewingInstruction {
    /// Create a new target pool
    /// Accounts expected:
    /// 1. `[writable]` Pool account (PDA)
    /// 2. `[signer]` Pool creator
    /// 3. `[]` System program
    CreateTargetPool {
        pool_id: String,
        target_hashes: Vec<[u8; 32]>,
    },
    
    /// Submit a remote viewing session (initial submission without target assignment)
    /// Accounts expected:
    /// 1. `[writable]` Session account (PDA)
    /// 2. `[]` Pool account
    /// 3. `[signer]` Session submitter
    /// 4. `[]` System program
    /// 5. `[]` Clock sysvar
    SubmitSession {
        session_id: String,
        pool_id: String,
        session_media_hash: [u8; 32],
        target_selector_program: Pubkey,
    },
    
    /// Finalize a session with target assignment based on submission block
    /// Accounts expected:
    /// 1. `[writable]` Session account (PDA)
    /// 2. `[]` Pool account
    /// 3. `[signer]` Caller (can be anyone)
    /// 4. `[]` Clock sysvar
    FinalizeSession {
        session_id: String,
        submission_blockhash: String, // Change to base58 string
    },
}

// State structures
#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub struct TargetPool {
    pub pool_id: String,
    pub creator: Pubkey,
    pub target_count: u16,
    pub targets: Vec<[u8; 32]>,
    pub created_at: i64,
}

#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub struct Session {
    pub session_id: String,
    pub pool_id: String,
    pub session_media_hash: [u8; 32],
    pub submission_slot: Slot,
    pub submission_blockhash: [u8; 32],
    pub assigned_target_index: u16,
    pub target_selector_program: Pubkey,
    pub submitter: Pubkey,
    pub submitted_at: i64,
    pub finalized: bool,
    pub finalized_at: i64,
}

// Error types
#[derive(Debug, Clone)]
pub enum RemoteViewingError {
    InvalidInstruction,
    InvalidPoolId,
    InvalidSessionId,
    PoolAlreadyExists,
    SessionAlreadyExists,
    PoolNotFound,
    InvalidTargetCount,
    AccountDataTooSmall,
    SessionNotFound,
    SessionAlreadyFinalized,
    TooEarlyToFinalize,
    InvalidSlotHash,
}

impl From<RemoteViewingError> for ProgramError {
    fn from(e: RemoteViewingError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

// Entry point
entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let instruction = RemoteViewingInstruction::try_from_slice(instruction_data)
        .map_err(|_| RemoteViewingError::InvalidInstruction)?;

    match instruction {
        RemoteViewingInstruction::CreateTargetPool { pool_id, target_hashes } => {
            process_create_target_pool(program_id, accounts, pool_id, target_hashes)
        }
        RemoteViewingInstruction::SubmitSession {
            session_id,
            pool_id,
            session_media_hash,
            target_selector_program,
        } => {
            process_submit_session(
                program_id,
                accounts,
                session_id,
                pool_id,
                session_media_hash,
                target_selector_program,
            )
        }
        RemoteViewingInstruction::FinalizeSession { session_id, submission_blockhash } => {
            process_finalize_session(program_id, accounts, session_id, submission_blockhash)
        }
    }
}

fn process_create_target_pool(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    pool_id: String,
    target_hashes: Vec<[u8; 32]>,
) -> ProgramResult {
    let account_info_iter = &mut accounts.iter();
    let pool_account = next_account_info(account_info_iter)?;
    let creator_account = next_account_info(account_info_iter)?;
    let system_program = next_account_info(account_info_iter)?;

    // Verify creator is signer
    if !creator_account.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Derive PDA for pool
    // Hash the pool_id to ensure it fits within the 32-byte seed limit
    let pool_id_hash = hash(pool_id.as_bytes());
    let (pool_pda, bump) = Pubkey::find_program_address(
        &[b"target_pool", pool_id_hash.as_ref()],
        program_id,
    );

    // Verify PDA matches
    if pool_pda != *pool_account.key {
        return Err(ProgramError::InvalidArgument);
    }

    // Check if pool already exists
    if pool_account.data_len() > 0 {
        return Err(RemoteViewingError::PoolAlreadyExists.into());
    }

    // Validate input parameters
    if pool_id.is_empty() {
        return Err(RemoteViewingError::InvalidPoolId.into());
    }
    
    if target_hashes.is_empty() {
        return Err(RemoteViewingError::InvalidTargetCount.into());
    }

    // Validate reasonable limits (prevent excessive storage costs)
    if target_hashes.len() > 10000 {
        return Err(RemoteViewingError::InvalidTargetCount.into());
    }

    // Get current time
    let clock = Clock::get()?;

    // Create the pool data
    let pool = TargetPool {
        pool_id: pool_id.clone(),
        creator: *creator_account.key,
        target_count: target_hashes.len() as u16,
        targets: target_hashes,
        created_at: clock.unix_timestamp,
    };

    // Calculate required space
    let space = pool.try_to_vec()?.len();
    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(space);

    // Create the account using invoke_signed for PDA
    invoke_signed(
        &system_instruction::create_account(
            creator_account.key,
            pool_account.key,
            lamports,
            space as u64,
            program_id,
        ),
        &[creator_account.clone(), pool_account.clone(), system_program.clone()],
        &[&[b"target_pool", pool_id_hash.as_ref(), &[bump]]],
    )?;

    // Write data to account
    pool.serialize(&mut &mut pool_account.data.borrow_mut()[..])?;

    msg!("Created target pool: {}", pool_id);
    Ok(())
}

fn process_submit_session(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    session_id: String,
    pool_id: String,
    session_media_hash: [u8; 32],
    target_selector_program: Pubkey,
) -> ProgramResult {
    let account_info_iter = &mut accounts.iter();
    let session_account = next_account_info(account_info_iter)?;
    let pool_account = next_account_info(account_info_iter)?;
    let submitter_account = next_account_info(account_info_iter)?;
    let system_program = next_account_info(account_info_iter)?;
    let clock_sysvar = next_account_info(account_info_iter)?;

    // Verify submitter is signer
    if !submitter_account.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Derive PDA for session
    // Hash the session_id to ensure it fits within the 32-byte seed limit
    let session_id_hash = hash(session_id.as_bytes());
    let (session_pda, bump) = Pubkey::find_program_address(
        &[b"session", session_id_hash.as_ref()],
        program_id,
    );

    // Verify PDA matches
    if session_pda != *session_account.key {
        return Err(ProgramError::InvalidArgument);
    }

    // Check if session already exists
    if session_account.data_len() > 0 {
        return Err(RemoteViewingError::SessionAlreadyExists.into());
    }

    // Validate input parameters
    if session_id.is_empty() {
        return Err(RemoteViewingError::InvalidSessionId.into());
    }
    
    if pool_id.is_empty() {
        return Err(RemoteViewingError::InvalidPoolId.into());
    }

    // Load pool data to verify it exists
    let pool = TargetPool::try_from_slice(&pool_account.data.borrow())?;
    
    // Verify pool ID matches
    if pool.pool_id != pool_id {
        return Err(RemoteViewingError::PoolNotFound.into());
    }

    // Get current time and slot
    let clock = Clock::from_account_info(clock_sysvar)?;

    // Create the session data - note that assigned_target_index is set to u16::MAX
    // and submission_blockhash is empty until finalization
    let session = Session {
        session_id: session_id.clone(),
        pool_id,
        session_media_hash,
        submission_slot: clock.slot,
        submission_blockhash: [0; 32], // Will be filled during finalization
        assigned_target_index: u16::MAX, // Placeholder until finalization
        target_selector_program,
        submitter: *submitter_account.key,
        submitted_at: clock.unix_timestamp,
        finalized: false,
        finalized_at: 0,
    };

    // Calculate required space
    let space = session.try_to_vec()?.len();
    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(space);

    // Create the account using invoke_signed for PDA
    invoke_signed(
        &system_instruction::create_account(
            submitter_account.key,
            session_account.key,
            lamports,
            space as u64,
            program_id,
        ),
        &[submitter_account.clone(), session_account.clone(), system_program.clone()],
        &[&[b"session", session_id_hash.as_ref(), &[bump]]],
    )?;

    // Write data to account
    session.serialize(&mut &mut session_account.data.borrow_mut()[..])?;

    msg!("Submitted session: {} at slot: {}", session_id, clock.slot);
    Ok(())
}

fn process_finalize_session(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    session_id: String,
    submission_blockhash: String,
) -> ProgramResult {
    let account_info_iter = &mut accounts.iter();
    let session_account = next_account_info(account_info_iter)?;
    let pool_account = next_account_info(account_info_iter)?;
    let caller_account = next_account_info(account_info_iter)?;
    let clock_sysvar = next_account_info(account_info_iter)?;

    // Verify caller is signer (anyone can finalize)
    if !caller_account.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Load session data
    let mut session = Session::try_from_slice(&session_account.data.borrow())?;
    
    // Verify session ID matches
    if session.session_id != session_id {
        return Err(RemoteViewingError::SessionNotFound.into());
    }

    // Check if already finalized
    if session.finalized {
        return Err(RemoteViewingError::SessionAlreadyFinalized.into());
    }

    // Get current clock
    let clock = Clock::from_account_info(clock_sysvar)?;
    
    // Ensure at least 2 slots have passed since submission
    // This ensures the submission block is finalized and prevents manipulation
    if clock.slot < session.submission_slot + 2 {
        return Err(RemoteViewingError::TooEarlyToFinalize.into());
    }

    // Prevent finalization too long after submission to avoid slot hash expiry
    // SlotHashes sysvar typically keeps ~300 recent slots
    if clock.slot > session.submission_slot + 150 {
        return Err(RemoteViewingError::InvalidSlotHash.into());
    }

    // Load pool data
    let pool = TargetPool::try_from_slice(&pool_account.data.borrow())?;

    // Validate that the provided blockhash is not empty (basic sanity check)
    if submission_blockhash.is_empty() {
        return Err(RemoteViewingError::InvalidSlotHash.into());
    }
    
    // Convert base58 string to [u8; 32]
    let submission_blockhash_bytes = bs58::decode(&submission_blockhash)
        .into_vec()
        .map_err(|_| RemoteViewingError::InvalidSlotHash)?;
    
    if submission_blockhash_bytes.len() != 32 {
        return Err(RemoteViewingError::InvalidSlotHash.into());
    }
    
    let mut blockhash_array = [0u8; 32];
    blockhash_array.copy_from_slice(&submission_blockhash_bytes);
    
    // Calculate target index from the provided submission blockhash
    let assigned_target_index = calculate_target_index(&blockhash_array, pool.target_count);

    // Update session with finalization data
    session.submission_blockhash = blockhash_array;
    session.assigned_target_index = assigned_target_index;
    session.finalized = true;
    session.finalized_at = clock.unix_timestamp;

    // Write updated data back to account
    session.serialize(&mut &mut session_account.data.borrow_mut()[..])?;

    msg!(
        "Finalized session: {} with target index: {} using blockhash: {} from slot: {}", 
        session_id, 
        assigned_target_index,
        submission_blockhash,
        session.submission_slot
    );
    Ok(())
}

fn calculate_target_index(blockhash: &[u8; 32], target_count: u16) -> u16 {
    // Use first 8 bytes of blockhash as u64
    let mut bytes = [0u8; 8];
    bytes.copy_from_slice(&blockhash[0..8]);
    let value = u64::from_be_bytes(bytes);
    
    // Modulo to get index
    (value % target_count as u64) as u16
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_calculate_target_index() {
        let blockhash = [1u8; 32];
        let target_count = 5;
        let index = calculate_target_index(&blockhash, target_count);
        assert!(index < target_count);
    }
} 