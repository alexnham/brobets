import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import idl from "./matching-idl.json";
import { deployment } from "./matching";

const sponsored = [
  "propose_wager",
  "match_wager",
  "cancel_wager",
  "claim_wager",
];

// Trust boundary: the sponsor's signature spends its SOL, so it signs only a transaction
// that is exactly one wager action by `user`, optionally preceded by creating the user's
// own token account. With no other instruction allowed, the cost is bounded to the
// two-signature base fee plus fixed-size account rent.
// shortcut: no per-user or global spending budget, add before any non-devnet release.
export function sponsorSign(raw: Uint8Array, sponsor: Keypair, user: PublicKey) {
  const fail = (why: string): never => {
    throw Error(`Not sponsorable: ${why}`);
  };
  const d = deployment(),
    tx = Transaction.from(raw),
    payer = sponsor.publicKey;
  if (!tx.feePayer?.equals(payer)) fail("fee payer");
  const setup = tx.instructions.slice(0, -1),
    main = tx.instructions.at(-1);
  if (!main || setup.length > 1) return fail("instruction count");
  for (const ix of setup) {
    const want = [
      payer,
      getAssociatedTokenAddressSync(d.mint, user),
      user,
      d.mint,
      SystemProgram.programId,
      TOKEN_PROGRAM_ID,
    ];
    if (
      !ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) ||
      ix.data.length !== 1 ||
      ix.data[0] !== 1 ||
      ix.keys.length !== want.length ||
      !ix.keys.every((k, i) => k.pubkey.equals(want[i]))
    )
      fail("token account creation");
  }
  const abi = idl.instructions.find(
    (i) =>
      sponsored.includes(i.name) &&
      Buffer.from(i.discriminator).equals(main.data.subarray(0, 8)),
  );
  if (
    !abi ||
    !main.programId.equals(d.program) ||
    main.keys.length !== abi.accounts.length
  )
    return fail("instruction");
  const fixed: Record<string, PublicKey> = {
    payer,
    maker: user,
    taker: user,
    user,
    token_mint: d.mint,
    token_program: TOKEN_PROGRAM_ID,
    system_program: SystemProgram.programId,
  };
  abi.accounts.forEach((a, i) => {
    const k = main.keys[i],
      want = fixed[a.name];
    // The sponsor may appear only as the rent payer, never in any other slot.
    if (want ? !k.pubkey.equals(want) : k.pubkey.equals(payer))
      fail(`account ${a.name}`);
  });
  // Decoded signer flags are per transaction, so the signer set is checked here: exactly
  // the sponsor and the player, which also fixes the fee at two signatures.
  const message = tx.compileMessage();
  if (
    message.header.numRequiredSignatures !== 2 ||
    !message.accountKeys[1].equals(user)
  )
    fail("signers");
  tx.partialSign(sponsor);
  // Also proves the user signed this exact message.
  if (!tx.verifySignatures()) fail("user signature");
  return tx.serialize();
}
