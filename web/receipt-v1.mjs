// Fixed Borsh SubmissionV1 account reader. u64/i64 remain BigInt throughout.
export const ACCOUNT_BYTES = 1024;
export const DISCRIMINATOR = Uint8Array.from([0x47, 0xbb, 0x2d, 0xfd, 0xfa, 0x06, 0xf9, 0x78]);
const encoder = new TextEncoder();
const DOMAIN = encoder.encode("FlyPoW/SubmissionV1/summary/v1\0");

function bytes(value, offset, length) {
  return new Uint8Array(value.slice(offset, offset + length));
}
function hex(array) { return Array.from(array, b => b.toString(16).padStart(2, "0")).join(""); }

export function decodeSubmissionV1(input) {
  const raw = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (raw.byteLength !== ACCOUNT_BYTES) throw new Error("SubmissionV1 must be exactly 1024 bytes");
  if (!DISCRIMINATOR.every((byte, index) => raw[index] === byte)) throw new Error("wrong account discriminator");
  const buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  const view = new DataView(buffer);
  const u8 = at => view.getUint8(at);
  const u16 = at => view.getUint16(at, true);
  const u32 = at => view.getUint32(at, true);
  const i32 = at => view.getInt32(at, true);
  const u64 = at => view.getBigUint64(at, true);
  const i64 = at => view.getBigInt64(at, true);
  const header = {
    schemaVersion: u16(8), status: u8(10), bump: u8(11), flags: u32(12),
    acceptMask: u16(16), rejectMask: u16(18), roiCount: u8(20), topCount: u8(21),
    timeBinCount: u8(22), summaryEncoding: u8(23), readoutSchemaId: u32(24), verifierPolicyId: u32(28),
  };
  if (header.schemaVersion !== 1 || header.summaryEncoding !== 1 || header.status > 5 || header.flags !== 0)
    throw new Error("unsupported SubmissionV1 schema, state, or flags");
  if (header.roiCount > 16 || header.topCount > 8 || header.timeBinCount !== 32)
    throw new Error("invalid summary counts");
  if (((header.acceptMask | header.rejectMask) & ~7) !== 0 || (header.acceptMask & header.rejectMask) !== 0)
    throw new Error("invalid verifier masks");
  const identity = Object.fromEntries(["campaign", "miner", "payer", "rewardBeneficiary", "refundRecipient"]
    .map((key, index) => [key, hex(bytes(buffer, 32 + index * 32, 32))]));
  const task = {
    bodyId: u64(192), globalTaskIndex: u64(200), targetIndex: u32(208), stimulusIndex: u32(212),
    repeatIndex: u32(216), candidateSeq: u32(220), modelNeuronCount: u32(224),
    simulationSteps: u32(228), timeStepUs: u32(232), simulationConfigId: u32(236),
  };
  const hashes = Object.fromEntries(["taskId", "commitment", "resultRoot", "previewRoot", "archiveManifestHash", "summaryHash"]
    .map((key, index) => [key, hex(bytes(buffer, 240 + index * 32, 32))]));
  const lifecycle = {
    commitSlot: u64(432), committedUnixTs: i64(440), revealDeadlineTs: i64(448),
    verifyDeadlineTs: i64(456), revealedSlot: u64(464), verifiedSlot: u64(472),
    archiveDeadlineTs: i64(480), acceptedSlot: u64(488),
  };
  const funding = Object.fromEntries(["storagePrincipalLamports", "refundableAdvanceRemainingLamports", "serviceFeePaidLamports",
    "slashPaidLamports", "minerRewardWhole", "validatorRewardWhole"]
    .map((key, index) => [key, u64(496 + index * 8)]));
  const global = Array.from({ length: 8 }, (_, index) => u64(544 + index * 8));
  const roi = Array.from({ length: 16 }, (_, index) => i64(608 + index * 8));
  const time = Array.from({ length: 32 }, (_, index) => i32(736 + index * 4));
  const top = Array.from({ length: 8 }, (_, index) => ({
    bodyId: u64(864 + index * 16), deltaSpikes: i32(872 + index * 16),
    firstDivergenceStep: u32(876 + index * 16),
  }));
  for (let index = 0; index < header.topCount; index++) {
    const item = top[index];
    if (item.bodyId === 0n || item.firstDivergenceStep >= task.simulationSteps ||
        top.slice(0, index).some(previous => previous.bodyId === item.bodyId))
      throw new Error('invalid Top8 identity or step');
    if (index > 0) {
      const previous = top[index - 1];
      const previousMagnitude = previous.deltaSpikes < 0 ? -BigInt(previous.deltaSpikes) : BigInt(previous.deltaSpikes);
      const currentMagnitude = item.deltaSpikes < 0 ? -BigInt(item.deltaSpikes) : BigInt(item.deltaSpikes);
      if (previousMagnitude < currentMagnitude ||
          (previousMagnitude === currentMagnitude && previous.bodyId >= item.bodyId))
        throw new Error('Top8 ordering differs from canonical order');
    }
  }
  if (roi.slice(header.roiCount).some(value => value !== 0n) ||
      top.slice(header.topCount).some(item => item.bodyId !== 0n || item.deltaSpikes !== 0 || item.firstDivergenceStep !== 0) ||
      bytes(buffer, 992, 32).some(value => value !== 0))
    throw new Error("nonzero unused or reserved space");
  return { header, identity, task, hashes, lifecycle, funding, global, roi, time, top, raw: new Uint8Array(buffer) };
}

export async function verifySummaryHash(record, readoutRoot) {
  if (!(readoutRoot instanceof Uint8Array) || readoutRoot.length !== 32)
    throw new Error("readout root must be 32 bytes");
  const raw = record.raw;
  const parts = [DOMAIN, raw.slice(8, 10), raw.slice(24, 28), readoutRoot, raw.slice(12, 16),
    raw.slice(20, 24), raw.slice(240, 272), raw.slice(544, 992)];
  const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { joined.set(part, offset); offset += part.length; }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", joined));
  return hex(digest) === record.hashes.summaryHash;
}

export function toSafeNumber(value) {
  if (typeof value !== "bigint" || value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER))
    throw new RangeError("integer cannot be represented exactly by Number");
  return Number(value);
}

// Encode the public schema, never blindly echo record.raw. This catches edited values and overflows.
export function encodeSubmissionV1(record) {
  const raw=new Uint8Array(1024),view=new DataView(raw.buffer);raw.set(DISCRIMINATOR);
  const set=(at,value,width,signed=false)=>{if(typeof value==='number'&&!Number.isSafeInteger(value))throw new RangeError('unsafe integer');const x=BigInt(value),bits=BigInt(width*8),min=signed?-(1n<<(bits-1n)):0n,max=signed?(1n<<(bits-1n))-1n:(1n<<bits)-1n;if(x<min||x>max)throw new RangeError('Borsh integer overflow');let n=x;for(let i=0;i<width;i++){raw[at+i]=Number(n&255n);n>>=8n;}};
  const writeHex=(at,h)=>{if(!/^[a-f0-9]{64}$/.test(h))throw new Error('Expected 32-byte hex');raw.set(Uint8Array.from(h.match(/../g),b=>parseInt(b,16)),at);};
  const h=record.header;for(const [name,at,width] of [['schemaVersion',8,2],['status',10,1],['bump',11,1],['flags',12,4],['acceptMask',16,2],['rejectMask',18,2],['roiCount',20,1],['topCount',21,1],['timeBinCount',22,1],['summaryEncoding',23,1],['readoutSchemaId',24,4],['verifierPolicyId',28,4]])set(at,h[name],width);
  ['campaign','miner','payer','rewardBeneficiary','refundRecipient'].forEach((n,i)=>writeHex(32+i*32,record.identity[n]));
  ['bodyId','globalTaskIndex'].forEach((n,i)=>set(192+i*8,record.task[n],8));
  ['targetIndex','stimulusIndex','repeatIndex','candidateSeq','modelNeuronCount','simulationSteps','timeStepUs','simulationConfigId'].forEach((n,i)=>set(208+i*4,record.task[n],4));
  ['taskId','commitment','resultRoot','previewRoot','archiveManifestHash','summaryHash'].forEach((n,i)=>writeHex(240+i*32,record.hashes[n]));
  ['commitSlot','committedUnixTs','revealDeadlineTs','verifyDeadlineTs','revealedSlot','verifiedSlot','archiveDeadlineTs','acceptedSlot'].forEach((n,i)=>set(432+i*8,record.lifecycle[n],8,[1,2,3,6].includes(i)));
  ['storagePrincipalLamports','refundableAdvanceRemainingLamports','serviceFeePaidLamports','slashPaidLamports','minerRewardWhole','validatorRewardWhole'].forEach((n,i)=>set(496+i*8,record.funding[n],8));
  if(record.global.length!==8||record.roi.length!==16||record.time.length!==32||record.top.length!==8)throw new Error('Fixed summary lengths');
  record.global.forEach((v,i)=>set(544+i*8,v,8));record.roi.forEach((v,i)=>set(608+i*8,v,8,true));record.time.forEach((v,i)=>set(736+i*4,v,4,true));
  record.top.forEach((t,i)=>{set(864+i*16,t.bodyId,8);set(872+i*16,t.deltaSpikes,4,true);set(876+i*16,t.firstDivergenceStep,4);});
  decodeSubmissionV1(raw);return raw;
}
