## Solana Program Deployment

The project includes a Solana smart contract for cryptographically verifiable remote viewing sessions. The program ensures that target assignments are unpredictable and verifiable on-chain.

### Prerequisites

1. **Install Solana CLI** (if not already installed):

   ```shellscript
   sh -c "$(curl -sSfL https://release.solana.com/v2.2.19/install)"
   ```

2. **Ensure you have a funded wallet** at `./solana-wallet.json` with devnet SOL

### Deployment Commands

```shellscript
# Navigate to the program directory
cd solana-program

# Configure Solana CLI for devnet
solana config set --url https://api.devnet.solana.com
solana config set --keypair ../solana-wallet.json

# Check wallet balance (need at least ~0.01 SOL for deployment)
solana balance

# Build the program
cargo build-sbf

# Deploy to devnet
solana program deploy target/deploy/remote_viewing_verifier.so

# Verify deployment
solana program show <PROGRAM_ID>
```

### Current Deployment

- **Program ID**: `AgdxtGStJsyCZAZvZChtnTtaK774e3Yf2QWdq8gSfLuc`
- **Network**: Solana Devnet
- **Explorer**: [View on Solana Explorer](https://explorer.solana.com/address/AgdxtGStJsyCZAZvZChtnTtaK774e3Yf2QWdq8gSfLuc?cluster=devnet)

### Program Features

- **Target Pool Creation**: Deploy pools of image hashes for random selection
- **Session Submission**: Submit remote viewing sessions with content hashes
- **Cryptographic Target Assignment**: Use slot hashes for unpredictable target selection
- **Public Verification**: Anyone can verify the integrity of session assignments

### Two-Step Deployment Process

**Important**: Solana program deployment requires a two-step process due to the program ID being hardcoded in the smart contract source code.

#### Why Two Steps Are Required

The smart contract uses `declare_id!()` macro which requires knowing the program ID at compile time, but you can't know the program ID until after the first deployment. This creates a chicken-and-egg problem that requires:

1. **First deployment**: Get the program ID
2. **Update source code**: Insert the program ID into `declare_id!()`
3. **Second deployment**: Deploy the updated program

#### Deployment Process

**Step 1: Initial Deployment**

```shellscript
# Build and deploy to get the program ID
cargo build-sbf
solana program deploy target/deploy/remote_viewing_verifier.so
# Note the returned program ID
```

**Step 2: Update Source Code**

```rust
// In solana-program/src/lib.rs, update:
solana_program::declare_id!("YOUR_ACTUAL_PROGRAM_ID_HERE");
```

**Step 3: Redeploy with Correct Program ID**

```shellscript
# Rebuild and redeploy
cargo build-sbf
solana program deploy target/deploy/remote_viewing_verifier.so
```

#### Environment Variables

After deployment, update your environment variables using the network-based configuration:

```bash
# Network selection (devnet or mainnet-beta)
SOLANA_NETWORK=devnet

# Program IDs for each network
DEVNET_PROGRAM_ID=AgdxtGStJsyCZAZvZChtnTtaK774e3Yf2QWdq8gSfLuc
MAINNET_PROGRAM_ID=YOUR_MAINNET_PROGRAM_ID_HERE

# Private key (can be shared or network-specific)
SOLANA_PRIVATE_KEY=your-base58-private-key-here

# Optional: Network-specific private keys
# DEVNET_PRIVATE_KEY=your-devnet-private-key-here
# MAINNET_PRIVATE_KEY=your-mainnet-private-key-here
```
