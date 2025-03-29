import {
  Connection,
  PublicKey,
  VersionedTransaction,
  SystemProgram,
  TransactionMessage,
  MessageV0,
} from "@solana/web3.js";
import { createAssociatedTokenAccountInstruction } from "@solana/spl-token";
import { useState, useCallback, useRef, useEffect } from "react";
import { createJupiterApiClient, QuoteGetRequest, SwapRequest } from "@jup-ag/api";
import { toast } from "react-hot-toast";
import { SOL_MINT, REFER_PROGRAM_ID } from "@utils/globals";
import { fetchQuoteWithRetries } from "@utils/fetchQuote";
import { JUPITERSWAP } from "@utils/endpoints";

// Constants
const PLATFORM_FEE_BPS = 100;
const MAX_TRANSACTIONS_PER_BUNDLE = 5;

// Helper Functions

// Sleep utility
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Derive Fee Account
export async function getFeeAccount(
  referralAccount: PublicKey,
  mint: PublicKey
): Promise<PublicKey> {
  const [feeAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("referral_ata"), referralAccount.toBuffer(), mint.toBuffer()],
    REFER_PROGRAM_ID
  );
  return feeAccount;
}

// Submit swap request
const submitSwapRequest = async (swapRequest: SwapRequest): Promise<any> => {
  const response = await fetch(JUPITERSWAP, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(swapRequest),
  });

  const json = await response.json();
  console.log('Full swap response:', json);

  if (!response.ok || json.error) {
    throw new Error(json.error || "Failed to execute swap");
  }

  // Return the entire transaction instead of just instructions
  return {
    transaction: VersionedTransaction.deserialize(
      Buffer.from(json.swapTransaction, "base64") as any
    ),
    lastValidBlockHeight: json.lastValidBlockHeight,
    computeUnitLimit: json.computeUnitLimit,
  };
};

// Add this helper function to chunk transactions
const chunkTransactions = (txs: Uint8Array[], size: number): Uint8Array[][] => {
  const chunks: Uint8Array[][] = [];
  for (let i = 0; i < txs.length; i += size) {
    chunks.push(txs.slice(i, i + size));
  }
  return chunks;
};

// Update the sendBundle function
const sendBundle = async (serializedTxs: Uint8Array[]) => {
  const response = await fetch('/api/jito/bundle', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      transactions: serializedTxs.map(tx => Buffer.from(tx).toString('base64'))
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.details || 'Failed to send bundle');
  }
  const json = await response.json();
  console.log('Bundle response:', json);
  return { 
    bundleId: json.bundleId,
    status: json.status 
  };
};

// Add this function to check bundle status
const checkBundleStatus = async (bundleId: string): Promise<string> => {
    const response = await fetch(`/api/jito/status?bundleId=${bundleId}`);
    if (!response.ok) {
        throw new Error('Failed to check bundle status');
    }
    const data = await response.json();
    return data.status;
};

// Hook: useCreateSwapInstructions
export const useCreateSwapInstructions = (
  publicKey: PublicKey | null,
  connection: Connection,
  signAllTransactions: (transactions: VersionedTransaction[]) => Promise<VersionedTransaction[]>,
  setMessage: React.Dispatch<React.SetStateAction<string | null>>,
  referralAccountPubkey: PublicKey
) => {
  const [sending, setSending] = useState(false);
  const pendingTransactions = useRef(new Set<string>());
  const jupiterQuoteApi = createJupiterApiClient();

  useEffect(() => {
    const transactions = pendingTransactions.current;
    return () => {
      transactions.clear();
    };
  }, []);

  const handleClosePopup = useCallback(
    async (
      answer: boolean,
      selectedItems: Set<TokenItem>,
      setErrorMessage: React.Dispatch<React.SetStateAction<string | null>>,
      bundleTip: number,
      slippageBps: number,
      onSuccess?: () => void
    ) => {
      console.log('handleClosePopup started:', { answer, selectedItems, bundleTip });

      if (!answer || selectedItems.size === 0 || !publicKey || !signAllTransactions) {
        console.log('Early return due to:', {
          answer,
          itemsSize: selectedItems.size,
          hasPublicKey: !!publicKey,
          hasSignAllTx: !!signAllTransactions
        });
        return;
      }

      setSending(true);
      setMessage("Preparing transactions...");

      try {
        console.log('Fetching tip account...');
        const tipAccountResponse = await fetch('/api/jito/getTipAccount');
        const tipAccount = (await tipAccountResponse.json()).tipAccount.value[0];
        console.log('Tip account received:', tipAccount);

        const selectedItemsArray = Array.from(selectedItems);
        console.log('Processing items:', selectedItemsArray);

        const serializedSwapTxs: Uint8Array[] = [];
        const skippedTokens: string[] = [];

        for (const selectedItem of selectedItemsArray) {
          try {
            console.log('Processing item:', selectedItem);
            const balanceInSmallestUnit = selectedItem.amount * Math.pow(10, selectedItem.decimals);
            console.log('Balance in smallest unit:', balanceInSmallestUnit);

            if (balanceInSmallestUnit === 0) {
              console.log('Skipping zero balance item');
              continue;
            }

            console.log('Getting fee account...');
            const feeAccount = await getFeeAccount(referralAccountPubkey, new PublicKey(SOL_MINT));
            console.log('Fee account:', feeAccount.toBase58());

            const params: QuoteGetRequest = {
              inputMint: selectedItem.mintAddress,
              outputMint: SOL_MINT,
              amount: Number(balanceInSmallestUnit),
              platformFeeBps: PLATFORM_FEE_BPS,
              onlyDirectRoutes: false,
              asLegacyTransaction: false,
            };
            console.log('Fetching quote with params:', params);

            const quote = await fetchQuoteWithRetries(jupiterQuoteApi, params);
            console.log('Quote received:', quote);

            const swapRequest: SwapRequest = {
              userPublicKey: publicKey.toBase58(),
              wrapAndUnwrapSol: true,
              useSharedAccounts: true,
              feeAccount: feeAccount.toBase58(),
              quoteResponse: quote,
            };
            console.log('Submitting swap request:', swapRequest);

            const swapResponse = await submitSwapRequest(swapRequest);
            
            // Simulate the transaction before adding it to the bundle
            try {
              const { transaction: jupTransaction } = swapResponse;
              
              // Define debug log type
              type DebugLog = {
                token: {
                  symbol: string;
                  mintAddress: string;
                  tokenAddress: string;
                  amount: number;
                  decimals: number;
                  isATA: boolean;
                };
                transaction: {
                  header: any;
                  staticAccountKeys: Array<{
                    index: number;
                    address: string;
                    isMint: boolean;
                    isTokenAccount: boolean;
                    isSystemProgram: boolean;
                    isTokenProgram: boolean;
                    isJupiterProgram: boolean;
                  }>;
                  compiledInstructions: Array<{
                    index: number;
                    programIdIndex: number;
                    programId: string;
                    accountKeyIndexes: number[];
                    accounts: Array<{
                      index: number;
                      address: string;
                      isTokenAccount: boolean;
                      isMint: boolean;
                    }>;
                  }>;
                };
                tokenAccount?: {
                  exists: boolean;
                  address: string;
                  owner?: string;
                  mint?: string;
                  expectedMint: string;
                  matchesExpectedMint?: boolean;
                };
                tokenAccountError?: string;
                simulation?: {
                  attempt: number;
                  error: any;
                  logs: string[];
                  accounts: Array<{
                    index: number;
                    address: string;
                    exists: boolean;
                    isTokenAccount: boolean;
                    isMint: boolean;
                  }>;
                };
                failingInstruction?: {
                  index: number;
                  programIdIndex: number;
                  programId: string;
                  accountKeyIndexes: number[];
                  accounts: Array<{
                    index: number;
                    address: string;
                    isTokenAccount: boolean;
                    isMint: boolean;
                  }>;
                } | null;
                simulationError?: {
                  attempt: number;
                  error: string;
                  stack: string;
                };
              };

              // Create comprehensive debug log
              const debugLog: DebugLog = {
                token: {
                  symbol: selectedItem.symbol,
                  mintAddress: selectedItem.mintAddress,
                  tokenAddress: selectedItem.tokenAddress,
                  amount: selectedItem.amount,
                  decimals: selectedItem.decimals,
                  isATA: selectedItem.tokenAddress !== selectedItem.mintAddress
                },
                transaction: {
                  header: jupTransaction.message.header,
                  staticAccountKeys: jupTransaction.message.staticAccountKeys.map((key: PublicKey, idx: number) => ({
                    index: idx,
                    address: key.toBase58(),
                    isMint: key.toBase58() === selectedItem.mintAddress,
                    isTokenAccount: key.toBase58() === selectedItem.tokenAddress,
                    isSystemProgram: key.toBase58() === '11111111111111111111111111111111',
                    isTokenProgram: key.toBase58() === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
                    isJupiterProgram: key.toBase58() === 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
                  })),
                  compiledInstructions: jupTransaction.message.compiledInstructions.map((ix: any, idx: number) => ({
                    index: idx,
                    programIdIndex: ix.programIdIndex,
                    programId: jupTransaction.message.staticAccountKeys[ix.programIdIndex]?.toBase58(),
                    accountKeyIndexes: ix.accountKeyIndexes,
                    accounts: ix.accountKeyIndexes.map((accIdx: number) => ({
                      index: accIdx,
                      address: jupTransaction.message.staticAccountKeys[accIdx]?.toBase58(),
                      isTokenAccount: jupTransaction.message.staticAccountKeys[accIdx]?.toBase58() === selectedItem.tokenAddress,
                      isMint: jupTransaction.message.staticAccountKeys[accIdx]?.toBase58() === selectedItem.mintAddress
                    }))
                  }))
                }
              };

              // Check if token account exists
              try {
                const tokenAccountInfo = await connection.getAccountInfo(new PublicKey(selectedItem.tokenAddress));
                if (!tokenAccountInfo) {
                  console.log('\nToken account does not exist, creating ATA...');
                  // Create ATA transaction
                  const createAtaIx = createAssociatedTokenAccountInstruction(
                    publicKey, // payer
                    new PublicKey(selectedItem.tokenAddress), // ata
                    publicKey, // owner
                    new PublicKey(selectedItem.mintAddress) // mint
                  );
                  
                  console.log('\nCreating ATA with details:', {
                    payer: publicKey.toBase58(),
                    ata: selectedItem.tokenAddress,
                    owner: publicKey.toBase58(),
                    mint: selectedItem.mintAddress
                  });

                  const createAtaTx = new VersionedTransaction(
                    new TransactionMessage({
                      payerKey: publicKey,
                      recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
                      instructions: [createAtaIx],
                    }).compileToV0Message([])
                  );

                  // Simulate ATA creation
                  const ataSimulation = await connection.simulateTransaction(
                    createAtaTx,
                    {
                      sigVerify: false,
                      replaceRecentBlockhash: true,
                      accounts: {
                        encoding: 'base64',
                        addresses: createAtaTx.message.staticAccountKeys.map((key: PublicKey) => key.toBase58())
                      }
                    }
                  );

                  if (ataSimulation.value.err) {
                    console.warn('\nFailed to create ATA:', ataSimulation.value.err);
                    skippedTokens.push(selectedItem.symbol);
                    toast.error(`Failed to create token account for ${selectedItem.symbol}`);
                    continue;
                  }

                  console.log('\nATA created successfully. Waiting for account state to update...');
                  await sleep(2000); // Wait for account state to update

                  console.log('\nVerifying account after delay...');
                  const newTokenAccountInfo = await connection.getAccountInfo(new PublicKey(selectedItem.tokenAddress));
                  if (newTokenAccountInfo) {
                    console.log('New token account details:', {
                      address: selectedItem.tokenAddress,
                      owner: new PublicKey(newTokenAccountInfo.data.slice(32, 64)).toBase58(),
                      mint: new PublicKey(newTokenAccountInfo.data.slice(0, 32)).toBase58(),
                      expectedMint: selectedItem.mintAddress
                    });
                  }
                } else {
                  console.log('\nToken account exists. Verifying details:', {
                    address: selectedItem.tokenAddress,
                    owner: new PublicKey(tokenAccountInfo.data.slice(32, 64)).toBase58(),
                    mint: new PublicKey(tokenAccountInfo.data.slice(0, 32)).toBase58(),
                    expectedMint: selectedItem.mintAddress
                  });
                }

                // Verify Jupiter is using the correct token account
                const jupiterInstruction = jupTransaction.message.compiledInstructions.find(
                  (ix: any) => jupTransaction.message.staticAccountKeys[ix.programIdIndex]?.toBase58() === 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
                );

                if (jupiterInstruction) {
                  // Find all token accounts in the instruction
                  const tokenAccountIndices = jupiterInstruction.accountKeyIndexes.filter(
                    (idx: number) => jupTransaction.message.staticAccountKeys[idx]?.toBase58() === selectedItem.tokenAddress
                  );

                  if (tokenAccountIndices.length === 0) {
                    console.warn('\nERROR: Jupiter instruction not using our token account');
                    console.warn('Our token account:', selectedItem.tokenAddress);
                    console.warn('Jupiter instruction accounts:', jupiterInstruction.accountKeyIndexes.map(
                      (idx: number) => jupTransaction.message.staticAccountKeys[idx]?.toBase58()
                    ));
                    skippedTokens.push(selectedItem.symbol);
                    toast.error(`Cannot swap ${selectedItem.symbol}: Jupiter using incorrect token account`);
                    continue;
                  }

                  // Log the token account usage
                  console.log('\nToken account usage in Jupiter instruction:', {
                    tokenAccount: selectedItem.tokenAddress,
                    indices: tokenAccountIndices,
                    allAccounts: jupiterInstruction.accountKeyIndexes.map(
                      (idx: number) => ({
                        index: idx,
                        address: jupTransaction.message.staticAccountKeys[idx]?.toBase58(),
                        isTokenAccount: jupTransaction.message.staticAccountKeys[idx]?.toBase58() === selectedItem.tokenAddress,
                        isMint: jupTransaction.message.staticAccountKeys[idx]?.toBase58() === selectedItem.mintAddress
                      })
                    )
                  });
                }
              } catch (error) {
                console.warn('\nError checking/creating token account:', error);
                skippedTokens.push(selectedItem.symbol);
                toast.error(`Failed to process token account for ${selectedItem.symbol}`);
                continue;
              }

              // Simulate transaction
              let simulationSuccess = false;
              let lastSimError = null;
              
              for (let attempt = 0; attempt < 3; attempt++) {
                try {
                  // Add a small delay after ATA creation to ensure account state is updated
                  if (attempt === 0) {
                    await sleep(1000);
                  }

                  const simulation = await connection.simulateTransaction(
                    jupTransaction,
                    {
                      sigVerify: false,
                      replaceRecentBlockhash: true,
                      accounts: {
                        encoding: 'base64',
                        addresses: jupTransaction.message.staticAccountKeys.map((key: PublicKey) => key.toBase58())
                      },
                      commitment: 'confirmed',
                      minContextSlot: 0
                    }
                  );

                  // Log account states for debugging
                  console.log('\nAccount states in simulation:', simulation.value.accounts?.map((acc, idx) => ({
                    index: idx,
                    address: jupTransaction.message.staticAccountKeys[idx]?.toBase58(),
                    exists: !!acc,
                    isTokenAccount: idx === jupTransaction.message.staticAccountKeys.findIndex(
                      (key: PublicKey) => key.toBase58() === selectedItem.tokenAddress
                    ),
                    isMint: idx === jupTransaction.message.staticAccountKeys.findIndex(
                      (key: PublicKey) => key.toBase58() === selectedItem.mintAddress
                    )
                  })));

                  debugLog.simulation = {
                    attempt: attempt + 1,
                    error: simulation.value.err,
                    logs: simulation.value.logs || [],
                    accounts: simulation.value.accounts?.map((acc, idx) => ({
                      index: idx,
                      address: jupTransaction.message.staticAccountKeys[idx]?.toBase58() || '',
                      exists: !!acc,
                      isTokenAccount: idx === jupTransaction.message.staticAccountKeys.findIndex(
                        (key: PublicKey) => key.toBase58() === selectedItem.tokenAddress
                      ),
                      isMint: idx === jupTransaction.message.staticAccountKeys.findIndex(
                        (key: PublicKey) => key.toBase58() === selectedItem.mintAddress
                      )
                    })) || []
                  };

                  if (simulation.value.err) {
                    lastSimError = simulation.value.err;
                    const instructionError = simulation.value.err as { InstructionError: [number, any] };
                    const failingInstruction = jupTransaction.message.compiledInstructions[instructionError.InstructionError[0]];
                    debugLog.failingInstruction = failingInstruction ? {
                      index: instructionError.InstructionError[0],
                      programIdIndex: failingInstruction.programIdIndex,
                      programId: jupTransaction.message.staticAccountKeys[failingInstruction.programIdIndex]?.toBase58(),
                      accountKeyIndexes: failingInstruction.accountKeyIndexes,
                      accounts: failingInstruction.accountKeyIndexes.map((idx: number) => ({
                        index: idx,
                        address: jupTransaction.message.staticAccountKeys[idx]?.toBase58(),
                        isTokenAccount: jupTransaction.message.staticAccountKeys[idx]?.toBase58() === selectedItem.tokenAddress,
                        isMint: jupTransaction.message.staticAccountKeys[idx]?.toBase58() === selectedItem.mintAddress
                      }))
                    } : null;

                    // If this is the first attempt and we're getting a token account error,
                    // try to verify the token account exists
                    if (attempt === 0) {
                      try {
                        const tokenAccountInfo = await connection.getAccountInfo(new PublicKey(selectedItem.tokenAddress));
                        console.log('\nToken account verification:', {
                          address: selectedItem.tokenAddress,
                          exists: !!tokenAccountInfo,
                          owner: tokenAccountInfo ? new PublicKey(tokenAccountInfo.data.slice(32, 64)).toBase58() : null,
                          mint: tokenAccountInfo ? new PublicKey(tokenAccountInfo.data.slice(0, 32)).toBase58() : null,
                          expectedMint: selectedItem.mintAddress
                        });
                      } catch (error) {
                        console.warn('\nError verifying token account:', error);
                      }
                    }

                    await sleep(1000);
                    continue;
                  }

                  simulationSuccess = true;
                  break;
                } catch (simError: any) {
                  lastSimError = simError;
                  debugLog.simulationError = {
                    attempt: attempt + 1,
                    error: simError.message,
                    stack: simError.stack
                  };
                  await sleep(1000);
                }
              }

              // Log the complete debug information
              console.log('\n=== COMPLETE DEBUG LOG ===');
              console.log(JSON.stringify(debugLog, null, 2));
              console.log('=== END DEBUG LOG ===\n');

              if (!simulationSuccess) {
                skippedTokens.push(selectedItem.symbol);
                const errorMessage = lastSimError ? 
                  `Skipping ${selectedItem.symbol}: Simulation failed after 3 attempts. Last error: ${JSON.stringify(lastSimError)}` :
                  `Skipping ${selectedItem.symbol}: Simulation failed after 3 attempts`;
                toast.error(errorMessage);
                continue;
              }
              
              // Only add successful simulations to the bundle
              serializedSwapTxs.push(jupTransaction.serialize());
              console.log(`\n=== Successfully added ${selectedItem.symbol} to bundle ===`);
              console.log('Transaction serialized and ready for bundling');
            } catch (error: unknown) {
              // Skip this swap if simulation throws an error
              skippedTokens.push(selectedItem.symbol);
              const errorMessage = error instanceof Error ? error.message : 'Unknown error';
              toast.error(`Skipping ${selectedItem.symbol}: ${errorMessage}`);
              console.warn('Simulation error for token:', selectedItem.symbol, error);
              continue;
            }
          } catch (error) {
            // Skip this swap if quote/swap request fails
            skippedTokens.push(selectedItem.symbol);
            toast.error(`Failed to process ${selectedItem.symbol}`);
            console.warn('Error processing swap for item:', selectedItem, error);
            continue;
          }
        }

        if (skippedTokens.length > 0) {
          toast.error(`Skipped tokens: ${skippedTokens.join(', ')}`);
        }

        if (serializedSwapTxs.length === 0) {
          throw new Error("No valid swaps to process after simulations");
        }

        if (serializedSwapTxs.length > 0) {
          try {
            const bundleChunks = chunkTransactions(serializedSwapTxs, MAX_TRANSACTIONS_PER_BUNDLE - 1);
            console.log(`Split into ${bundleChunks.length} bundles`);

            for (let i = 0; i < bundleChunks.length; i++) {
              try {
                // Get a fresh blockhash for each bundle
                const { blockhash } = await connection.getLatestBlockhash('confirmed');
                console.log(`Bundle ${i + 1} using blockhash:`, blockhash);

                // Create tip transaction with the fresh blockhash
                const tipInstruction = SystemProgram.transfer({
                  fromPubkey: publicKey,
                  toPubkey: new PublicKey(tipAccount),
                  lamports: bundleTip,
                });

                const tipMessage = new TransactionMessage({
                  payerKey: publicKey,
                  recentBlockhash: blockhash,
                  instructions: [tipInstruction],
                }).compileToV0Message([]);

                const tipTransaction = new VersionedTransaction(tipMessage);
                
                // Update the blockhash for each swap transaction in this chunk
                const updatedSwapTxs = await Promise.all(
                  bundleChunks[i].map(async (serializedTx) => {
                    const tx = VersionedTransaction.deserialize(serializedTx);
                    const message = tx.message as MessageV0;
                    
                    // Just update the blockhash without signing
                    const newTx = new VersionedTransaction(
                      new MessageV0({
                        header: message.header,
                        staticAccountKeys: message.staticAccountKeys,
                        recentBlockhash: blockhash,
                        compiledInstructions: message.compiledInstructions,
                        addressTableLookups: message.addressTableLookups
                      })
                    );
                    return newTx; // Return unsigned transaction
                  })
                );

                // Sign all transactions at once
                const allTxsToSign = [tipTransaction, ...updatedSwapTxs];
                let signedTxs;
                try {
                  signedTxs = await signAllTransactions(allTxsToSign);
                } catch (error: any) {
                  if (error.message.includes('rejected')) {
                    toast.error('Transaction signing cancelled by user');
                    setMessage(null);
                    setSending(false);
                    pendingTransactions.current.clear();
                    return; // Exit early
                  }
                  throw error; // Re-throw other errors
                }

                // Serialize all signed transactions
                const bundleTxs = signedTxs.map(tx => tx.serialize());
                
                setMessage(`Sending bundle ${i + 1} of ${bundleChunks.length}...`);
                const { bundleId, status } = await sendBundle(bundleTxs);
                if (!bundleId) throw new Error('No bundle ID received');
                console.log(`Bundle ${i + 1} submitted with ID:`, bundleId);

                // Poll for status a few times
                let finalStatus = status;
                for (let attempt = 0; attempt < 3; attempt++) {
                    await sleep(10000); // Wait 10 seconds between checks
                    try {
                        finalStatus = await checkBundleStatus(bundleId);
                        if (finalStatus === 'accepted' || finalStatus === 'finalized') {
                            break;
                        }
                    } catch (error) {
                        console.warn('Status check error:', error);
                    }
                }

                toast.success(`Bundle ${i + 1}/${bundleChunks.length} - ID: ${bundleId} - Status: ${finalStatus}`);

                // Wait between bundles
                if (i < bundleChunks.length - 1) {
                  await sleep(2000); // Increased delay between bundles
                }
              } catch (error) {
                console.warn(`Error processing bundle ${i + 1}:`, error);
                throw error; // Re-throw to be caught by outer try-catch
              }
            }

            setMessage(`All bundles sent successfully. Refreshing in 3 seconds...`);
            await sleep(3000);
            setSending(false);
            onSuccess?.();
            pendingTransactions.current.clear();
          } catch (error: any) {
            console.warn("Bundle error:", error);
            setErrorMessage(typeof error === 'string' ? error : error.message || 'Unknown error');
            toast.error(`Failed to send bundles: ${error.message || 'Unknown error'}`);
            setSending(false);
          }
        } else {
          toast.error("Error: No valid transactions to bundle.");
        }
      } catch (error: any) {
        console.warn("Swap error:", error);
        setErrorMessage(error.toString());
        toast.error("Failed to complete swaps. You might need to increase your slippage tolerance or try again later when the market is less volatile. If the issue persists, please reach out to our support team.");
      } finally {
        setSending(false);
        pendingTransactions.current.clear();
      }
    },
    [publicKey, signAllTransactions, connection, setMessage, referralAccountPubkey, jupiterQuoteApi]
  );


  return { handleClosePopup, sending, pendingTransactions: pendingTransactions.current };
};

// Types
export type TokenItem = {
  symbol: string;
  mintAddress: string;
  amount: number;
  decimals: number;
  tokenAddress: string;
};
