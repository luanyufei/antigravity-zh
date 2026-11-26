'use strict';

/**
 * Pure telemetry calculation helpers for antigravity-zh.
 * Clean-room MIT implementation inspired by local LanguageServerService RPC schemas
 * (GetUserStatus, RetrieveUserQuotaSummary, GetAvailableModels,
 *  GetCascadeTrajectorySteps, GetCascadeTrajectoryGeneratorMetadata).
 */

function toSafeInt(val) {
  if (val === null || val === undefined || val === '') return 0;
  const n = Number(val);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function parseDurationSec(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw >= 0 ? raw : null;
  }
  if (typeof raw === 'string') {
    const s = raw.trim();
    const m = /^(\d+(?:\.\d+)?)s$/i.exec(s);
    if (m) {
      const n = Number(m[1]);
      return Number.isFinite(n) && n >= 0 ? n : null;
    }
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  if (typeof raw === 'object') {
    const sec = Number(raw.seconds || 0) + Number(raw.nanos || 0) / 1e9;
    return Number.isFinite(sec) && sec >= 0 ? sec : null;
  }
  return null;
}

function normalizeModelKey(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw.trim().toLowerCase().replace(/^model_/, '');
}

function shortenModelName(displayName) {
  if (!displayName || typeof displayName !== 'string') return '';
  let s = displayName
    .trim()
    .replace(/\s*\((?:Extra\s*High|XHigh|High|Medium|Low|Thinking|Minimal|Fast)\)\s*$/i, '')
    .trim();
  // Canonicalize raw model IDs (e.g. "gemini-3.8-flash-n", "gemini-3.7-flash") into clean display names
  const low = s.toLowerCase();
  if (/^gemini[\s._-]*4[\s._-]*neon\b/.test(low)) return 'Gemini 4 Neon';
  if (/^gemini[\s._-]*4[\s._-]*hydrogen\b/.test(low)) return 'Gemini 4 Hydrogen';
  if (/^gemini[\s._-]*4[\s._-]*argon\b/.test(low)) return 'Gemini 4 Argon';
  if (/^gemini[\s._-]*4[\s._-]*carbon\b/.test(low)) return 'Gemini 4 Carbon';
  if (/^gemini[\s._-]*3\.8[\s._-]*flash\b/.test(low)) return 'Gemini 3.8 Flash';
  if (/^gemini[\s._-]*3\.7[\s._-]*flash\b/.test(low)) return 'Gemini 3.7 Flash';
  if (/^gemini[\s._-]*3\.6[\s._-]*flash\b/.test(low)) return 'Gemini 3.6 Flash';
  if (/^gemini[\s._-]*3\.5[\s._-]*flash[\s._-]*lite\b/.test(low)) return 'Gemini 3.5 Flash Lite';
  if (/^gemini[\s._-]*3\.1[\s._-]*pro\b/.test(low)) return 'Gemini 3.1 Pro';
  if (/^gemini[\s._-]*3(?:\.0)?[\s._-]*pro\b/.test(low)) return 'Gemini 3 Pro';
  if (/^gemini[\s._-]*2\.5[\s._-]*pro\b/.test(low)) return 'Gemini 2.5 Pro';
  if (/^gemini[\s._-]*2\.5[\s._-]*flash\b/.test(low)) return 'Gemini 2.5 Flash';
  if (/^gemini[\s._-]*pro(?:[\s._-]|$)/.test(low)) return 'Gemini Pro';
  if (/^claude[\s._-]*opus[\s._-]*5[\s._-]*5\b/.test(low)) return 'Claude Opus 5.5';
  if (/^claude[\s._-]*sonnet[\s._-]*5[\s._-]*5\b/.test(low)) return 'Claude Sonnet 5.5';
  if (/^claude[\s._-]*opus[\s._-]*4[\s._-]*6\b/.test(low)) return 'Claude Opus 4.6';
  if (/^claude[\s._-]*sonnet[\s._-]*4[\s._-]*6\b/.test(low)) return 'Claude Sonnet 4.6';
  return s;
}

/**
 * Build model capacity & display name catalog from GetAvailableModels + GetUserStatus.
 */
function buildModelCatalog(userStatusRes, availableModelsRes) {
  const byKey = new Map();
  const byDisplay = new Map();

  const modelsObj = availableModelsRes?.response?.models || availableModelsRes?.models || {};
  const entries = Array.isArray(modelsObj)
    ? modelsObj.map((item) => [item?.model || item?.modelId || item?.id || '', item])
    : Object.entries(modelsObj);

  for (const [key, item] of entries) {
    if (!item || typeof item !== 'object') continue;
    const rawId = String(item.model || item.modelId || key || '').trim();
    const displayName = typeof item.displayName === 'string' ? item.displayName.trim() : '';
    const maxTokens = toSafeInt(item.maxTokens ?? item.max_tokens) || null;
    const maxOutputTokens = toSafeInt(item.maxOutputTokens ?? item.max_output_tokens) || null;
    const rec = { modelId: rawId, displayName: displayName || rawId, maxTokens, maxOutputTokens };

    const nk1 = normalizeModelKey(rawId);
    const nk2 = normalizeModelKey(key);
    if (nk1) byKey.set(nk1, rec);
    if (nk2) byKey.set(nk2, rec);
    if (displayName) byDisplay.set(displayName.toLowerCase(), rec);
  }

  // Link placeholder aliases from GetUserStatus (e.g. MODEL_PLACEHOLDER_M532 -> "Gemini 4 Neon (High)")
  const configs = userStatusRes?.userStatus?.cascadeModelConfigData?.clientModelConfigs
    || userStatusRes?.cascadeModelConfigData?.clientModelConfigs
    || [];
  for (const cfg of Array.isArray(configs) ? configs : []) {
    if (!cfg || typeof cfg !== 'object') continue;
    const label = String(cfg.label || cfg.modelDisplayName || '').trim();
    const aliasModel = String(cfg.modelOrAlias?.model || cfg.modelId || cfg.model || '').trim();
    const directMax = toSafeInt(cfg.maxTokens ?? cfg.max_tokens) || null;
    const matched = (label && byDisplay.get(label.toLowerCase()))
      || (aliasModel && byKey.get(normalizeModelKey(aliasModel)))
      || null;
    const merged = {
      modelId: aliasModel || matched?.modelId || '',
      displayName: label || matched?.displayName || aliasModel,
      maxTokens: directMax || matched?.maxTokens || null,
      maxOutputTokens: matched?.maxOutputTokens || null,
    };
    if (aliasModel) byKey.set(normalizeModelKey(aliasModel), merged);
    if (label && !byDisplay.has(label.toLowerCase())) {
      byDisplay.set(label.toLowerCase(), merged);
    }
  }

  return { byKey, byDisplay };
}

function lookupModelCapacity(catalog, candidates) {
  if (!catalog) return null;
  for (const raw of candidates) {
    if (!raw || typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const byD = catalog.byDisplay.get(trimmed.toLowerCase());
    if (byD && byD.maxTokens) return byD;
    const byK = catalog.byKey.get(normalizeModelKey(trimmed));
    if (byK && byK.maxTokens) return byK;
  }
  return null;
}

function classifyQuotaGroup(group) {
  const name = String(group?.displayName || group?.name || '').trim();
  const desc = String(group?.description || '').trim();
  const bucketIds = (Array.isArray(group?.buckets) ? group.buckets : [])
    .map((b) => String(b?.bucketId || ''))
    .join(' ');
  const combined = `${name} ${desc} ${bucketIds}`;
  if (/claude|anthropic|gpt|openai|3p|third.?party/i.test(combined)) {
    return { key: 'third_party', shortLabel: 'Claude / GPT', displayName: name || 'Claude & GPT' };
  }
  if (/gemini|google/i.test(combined)) {
    return { key: 'gemini', shortLabel: 'Gemini', displayName: name || 'Gemini Models' };
  }
  return { key: name.toLowerCase().replace(/[^a-z0-9]+/g, '_') || 'other', shortLabel: name.slice(0, 14) || 'Quota', displayName: name || 'Model Quota' };
}

function classifyBucketWindow(bucket) {
  const raw = `${bucket?.window || ''} ${bucket?.bucketId || ''} ${bucket?.displayName || ''}`.toLowerCase();
  if (/week|7d|7\s*day/.test(raw)) return 'weekly';
  if (/5h|five|hour/.test(raw)) return '5h';
  return raw.trim() || '5h';
}

/**
 * Parse GetUserStatus + RetrieveUserQuotaSummary into clean quota groups.
 */
function parseQuotaSnapshot(userStatusRes, quotaSummaryRes, nowMs = Date.now()) {
  const userStatus = userStatusRes?.userStatus || userStatusRes || null;
  const planInfo = userStatus?.planStatus?.planInfo || null;
  const planName = String(
    userStatus?.userTier?.name || userStatus?.userTier?.description || planInfo?.planName || ''
  ).trim() || null;

  const rawGroups = quotaSummaryRes?.response?.groups || quotaSummaryRes?.groups || [];
  const groups = [];

  for (const g of Array.isArray(rawGroups) ? rawGroups : []) {
    if (!g || typeof g !== 'object') continue;
    const meta = classifyQuotaGroup(g);
    const buckets = [];
    for (const b of Array.isArray(g.buckets) ? g.buckets : []) {
      if (!b || typeof b !== 'object') continue;
      const frac = typeof b.remainingFraction === 'number' && Number.isFinite(b.remainingFraction)
        ? Math.max(0, Math.min(1, b.remainingFraction))
        : null;
      const resetMs = b.resetTime ? Date.parse(b.resetTime) : NaN;
      const windowKey = classifyBucketWindow(b);
      buckets.push({
        bucketId: String(b.bucketId || `${meta.key}-${windowKey}`),
        windowKey,
        remainingFraction: frac,
        percent: frac !== null ? Math.round(frac * 100) : null,
        resetTime: b.resetTime || null,
        resetAtMs: Number.isFinite(resetMs) ? resetMs : null,
      });
    }
    // Order: 5h first, then weekly
    buckets.sort((a, b) => {
      const rank = (k) => (k === '5h' ? 0 : k === 'weekly' ? 1 : 2);
      return rank(a.windowKey) - rank(b.windowKey);
    });
    if (buckets.length > 0) {
      groups.push({
        key: meta.key,
        shortLabel: meta.shortLabel,
        displayName: meta.displayName,
        buckets,
      });
    }
  }

  return {
    ok: groups.length > 0,
    planName,
    groups,
    fetchedAtMs: nowMs,
  };
}

/**
 * Normalize a single entry from GetCascadeTrajectoryGeneratorMetadata.
 */
function normalizeGeneratorEntry(entry, ordinal) {
  if (!entry || typeof entry !== 'object') return null;
  const cm = entry.chatModel || {};
  const usage = cm.usage || {};
  const inputTokens = toSafeInt(usage.inputTokens ?? usage.promptTokens);
  const cacheReadTokens = toSafeInt(usage.cacheReadTokens ?? usage.cachedContentTokenCount);
  const totalInput = inputTokens + cacheReadTokens;
  const responseOutputTokens = toSafeInt(usage.responseOutputTokens);
  const thinkingOutputTokens = toSafeInt(usage.thinkingOutputTokens);
  const outputTokens = toSafeInt(usage.outputTokens) || (responseOutputTokens + thinkingOutputTokens);

  const ttftSec = parseDurationSec(cm.timeToFirstToken);
  const streamingSec = parseDurationSec(cm.streamingDuration);

  // Speed quality check: exclude ultra-short micro-bursts (<0.15s with <20 tokens)
  // and tool-only spikes where TTFT vastly dominates a tiny sub-second stream window.
  let tps = null;
  let speedReliable = false;
  if (outputTokens > 0 && streamingSec !== null && streamingSec > 0) {
    const rawTps = outputTokens / streamingSec;
    const isTinyBurst = streamingSec < 0.15 && outputTokens < 20;
    const isSuspectSpike = streamingSec < 0.8 && ttftSec !== null && ttftSec >= 2 && (ttftSec / streamingSec) >= 20 && outputTokens < 60;
    if (!isTinyBurst && !isSuspectSpike && Number.isFinite(rawTps) && rawTps > 0 && rawTps < 2500) {
      tps = Math.round(rawTps * 10) / 10;
      speedReliable = true;
    }
  }

  const rawStepIndices = Array.isArray(entry.stepIndices)
    ? entry.stepIndices.map((x) => Number(x)).filter((x) => Number.isInteger(x) && x >= 0)
    : [];
  const minStepIdx = rawStepIndices.length > 0 ? Math.min(...rawStepIndices) : null;
  const maxStepIdx = rawStepIndices.length > 0 ? Math.max(...rawStepIndices) : null;

  const modelId = String(cm.model || usage.model || '').trim();
  const plannerModelName = String(entry.plannerConfig?.modelName || cm.responseModel || '').trim();
  const displayName = String(cm.modelDisplayName || plannerModelName || modelId || '').trim();
  const shortModelName = shortenModelName(displayName) || displayName;

  // Authoritative host-enforced context window budget (e.g. 512,000 before auto-compaction),
  // distinct from the model's theoretical provider limit (e.g. 1,048,576 from GetAvailableModels).
  const csm = cm.chatStartMetadata || {};
  const cw = csm.contextWindowMetadata || {};
  const hostMaxContextTokens = toSafeInt(cw.maxContextTokens) || null;
  const hostEstimatedTokensUsed = toSafeInt(cw.estimatedTokensUsed) || null;
  const checkpointIndex = Number.isInteger(Number(csm.checkpointIndex)) ? Number(csm.checkpointIndex) : -1;
  const parsedCreatedAtMs = csm.createdAt ? Date.parse(csm.createdAt) : NaN;
  const createdAtMs = Number.isFinite(parsedCreatedAtMs) && parsedCreatedAtMs > 0 ? parsedCreatedAtMs : null;

  return {
    ordinal,
    minStepIdx,
    maxStepIdx,
    modelId,
    plannerModelName,
    displayName,
    shortModelName,
    inputTokens,
    cacheReadTokens,
    totalInput,
    outputTokens,
    responseOutputTokens,
    thinkingOutputTokens,
    ttftSec,
    streamingSec,
    tps,
    speedReliable,
    hostMaxContextTokens,
    hostEstimatedTokensUsed,
    checkpointIndex,
    createdAtMs,
  };
}

/**
 * Compute current context occupancy, session speed/cache summary, and per-turn summaries.
 */
function computeSessionMetrics({ userInputIndices = [], checkpointSteps = [], calls = [], modelCatalog = null }) {
  const validCalls = calls.filter((c) => c && (c.totalInput > 0 || c.outputTokens > 0));

  // 1. Current context occupancy (based on latest real model call & post-checkpoint check)
  let context = {
    usedTokens: null,
    maxTokens: null,
    providerMaxTokens: null,
    capacitySource: null,
    usedFraction: null,
    remainingTokens: null,
    remainingFraction: null,
    compacted: false,
    modelDisplayName: null,
    shortModelName: null,
  };

  const latestCall = validCalls.length > 0 ? validCalls[validCalls.length - 1] : null;
  if (latestCall) {
    const cap = lookupModelCapacity(modelCatalog, [
      latestCall.plannerModelName,
      latestCall.displayName,
      latestCall.modelId,
    ]);
    // Prefer host-reported active context budget (contextWindowMetadata.maxContextTokens, e.g. 512K)
    // over theoretical provider window (GetAvailableModels.maxTokens, e.g. 1M).
    let hostMax = latestCall.hostMaxContextTokens || null;
    if (!hostMax) {
      for (let i = validCalls.length - 1; i >= 0; i--) {
        if (validCalls[i].hostMaxContextTokens) {
          hostMax = validCalls[i].hostMaxContextTokens;
          break;
        }
      }
    }
    const providerMax = cap?.maxTokens || null;
    const maxTokens = hostMax || providerMax || null;
    const capacitySource = hostMax ? 'host' : (providerMax ? 'provider' : null);

    const lastCheckpoint = checkpointSteps.length > 0 ? checkpointSteps[checkpointSteps.length - 1] : null;
    const compactedAfterLatest = Boolean(
      lastCheckpoint &&
      latestCall.maxStepIdx !== null &&
      lastCheckpoint.index > latestCall.maxStepIdx
    );

    const usedTokens = compactedAfterLatest && lastCheckpoint?.estimatedTokens > 0
      ? lastCheckpoint.estimatedTokens
      : (latestCall.totalInput + latestCall.outputTokens);

    context = {
      usedTokens,
      maxTokens,
      providerMaxTokens: providerMax,
      capacitySource,
      usedFraction: maxTokens ? Math.max(0, usedTokens / maxTokens) : null,
      remainingTokens: maxTokens ? Math.max(0, maxTokens - usedTokens) : null,
      remainingFraction: maxTokens ? Math.max(0, 1 - usedTokens / maxTokens) : null,
      compacted: compactedAfterLatest,
      modelDisplayName: latestCall.displayName || cap?.displayName || null,
      shortModelName: latestCall.shortModelName || shortenModelName(cap?.displayName || '') || null,
    };
  }

  // 2. Session-level speed & cache hit rate
  let sessUncached = 0;
  let sessCacheRead = 0;
  let sessOutput = 0;
  let reliableOut = 0;
  let reliableSec = 0;
  let latestTps = null;
  let latestTtftSec = null;

  for (const c of validCalls) {
    sessUncached += c.inputTokens;
    sessCacheRead += c.cacheReadTokens;
    sessOutput += c.outputTokens;
    if (c.speedReliable && c.streamingSec > 0) {
      reliableOut += c.outputTokens;
      reliableSec += c.streamingSec;
      latestTps = c.tps;
    }
    if (c.ttftSec !== null) {
      latestTtftSec = c.ttftSec;
    }
  }
  const sessTotalIn = sessUncached + sessCacheRead;
  const session = {
    callCount: validCalls.length,
    totalInput: sessTotalIn,
    uncachedInput: sessUncached,
    cacheRead: sessCacheRead,
    totalOutput: sessOutput,
    cacheHitPct: sessTotalIn > 0 ? Math.round((sessCacheRead / sessTotalIn) * 100) : null,
    latestTps,
    avgTps: reliableSec > 0 ? Math.round((reliableOut / reliableSec) * 10) / 10 : latestTps,
    latestTtftSec: latestTtftSec !== null ? Math.round(latestTtftSec * 10) / 10 : null,
  };

  // 3. Per-turn summaries aligned with USER_INPUT step boundaries (for Figure 1 turn footers)
  const sortedInputs = [...userInputIndices].filter((x) => Number.isInteger(x) && x >= 0).sort((a, b) => a - b);
  const buckets = new Map(); // turnIndex -> calls[]
  for (const c of validCalls) {
    let turnIdx = 0;
    if (sortedInputs.length > 0 && c.minStepIdx !== null) {
      for (let i = 0; i < sortedInputs.length; i++) {
        if (sortedInputs[i] <= c.minStepIdx) turnIdx = i;
        else break;
      }
    } else if (sortedInputs.length > 0) {
      turnIdx = sortedInputs.length - 1;
    }
    if (!buckets.has(turnIdx)) buckets.set(turnIdx, []);
    buckets.get(turnIdx).push(c);
  }

  const turns = [];
  const sortedTurnKeys = Array.from(buckets.keys()).sort((a, b) => a - b);
  for (const tk of sortedTurnKeys) {
    const tCalls = buckets.get(tk);
    if (!tCalls || tCalls.length === 0) continue;

    let tIn = 0;
    let tCache = 0;
    let tOut = 0;
    let tRelOut = 0;
    let tRelSec = 0;
    let lastRelTps = null;

    for (const c of tCalls) {
      tIn += c.totalInput;
      tCache += c.cacheReadTokens;
      tOut += c.outputTokens;
      if (c.speedReliable && c.streamingSec > 0) {
        tRelOut += c.outputTokens;
        tRelSec += c.streamingSec;
        lastRelTps = c.tps;
      }
    }

    const last = tCalls[tCalls.length - 1];
    const turnTps = tRelSec > 0
      ? Math.round((tRelOut / tRelSec) * 10) / 10
      : lastRelTps;

    turns.push({
      turnKey: `turn-${tk}`,
      turnIndex: tk,
      callCount: tCalls.length,
      modelDisplayName: last.displayName,
      shortModelName: last.shortModelName,
      totalInput: tIn,
      cacheRead: tCache,
      totalOutput: tOut,
      cacheHitPct: tIn > 0 ? Math.round((tCache / tIn) * 100) : null,
      tps: turnTps,
      lastCall: {
        totalInput: last.totalInput,
        cacheRead: last.cacheReadTokens,
        totalOutput: last.outputTokens,
        cacheHitPct: last.totalInput > 0 ? Math.round((last.cacheReadTokens / last.totalInput) * 100) : null,
        tps: last.tps,
        ttftSec: last.ttftSec !== null ? Math.round(last.ttftSec * 10) / 10 : null,
      },
    });
  }

  return { context, session, turns };
}

/**
 * Estimate equivalent Developer API USD value from official public per-1M token rates.
 * Strictly separates uncached input, cached input reads (90-95% discount), and output tokens.
 */
const API_PRICING_RULES = [
  { re: /gemini[\s._-]*4[\s._-]*neon/i, inRate: 3.00, cacheRate: 0.15, outRate: 15.00 },
  { re: /gemini[\s._-]*4[\s._-]*hydrogen/i, inRate: 1.50, cacheRate: 0.075, outRate: 7.50 },
  { re: /gemini[\s._-]*4[\s._-]*(?:argon|carbon)/i, inRate: 2.00, cacheRate: 0.10, outRate: 10.00 },
  { re: /gemini[\s._-]*3\.[678][\s._-]*flash/i, inRate: 0.75, cacheRate: 0.075, outRate: 3.75 },
  { re: /gemini[\s._-]*3\.5[\s._-]*flash[\s._-]*lite|flash[\s._-]*lite/i, inRate: 0.30, cacheRate: 0.03, outRate: 2.50 },
  { re: /gemini[\s._-]*3(?:\.\d+)?[\s._-]*pro/i, inRate: 2.00, cacheRate: 0.20, outRate: 12.00 },
  { re: /gemini[\s._-]*2\.5[\s._-]*pro/i, inRate: 1.25, cacheRate: 0.125, outRate: 10.00 },
  { re: /gemini[\s._-]*2\.[05][\s._-]*flash/i, inRate: 0.30, cacheRate: 0.03, outRate: 2.50 },
  { re: /claude[\s._-]*opus[\s._-]*4/i, inRate: 15.00, cacheRate: 1.50, outRate: 75.00 },
  { re: /claude[\s._-]*opus/i, inRate: 4.00, cacheRate: 0.20, outRate: 20.00 },
  { re: /claude[\s._-]*sonnet[\s._-]*4/i, inRate: 3.00, cacheRate: 0.30, outRate: 15.00 },
  { re: /claude[\s._-]*sonnet/i, inRate: 2.00, cacheRate: 0.10, outRate: 10.00 },
  { re: /claude[\s._-]*haiku/i, inRate: 0.80, cacheRate: 0.08, outRate: 4.00 },
  { re: /gpt[\s._-]*5|\bo[34](?:\b|[\s._-])/i, inRate: 2.00, cacheRate: 0.20, outRate: 10.00 },
  { re: /gemini.*flash/i, inRate: 0.75, cacheRate: 0.075, outRate: 3.75 },
  { re: /gemini.*pro/i, inRate: 1.25, cacheRate: 0.125, outRate: 10.00 },
];

function lookupModelPricing(modelName) {
  const s = String(modelName || '').trim();
  if (!s) return null;
  for (const r of API_PRICING_RULES) {
    if (r.re.test(s)) return r;
  }
  return null;
}

function estimateModelCostUsd(modelName, totalInput, cacheRead, outputTokens) {
  const rate = lookupModelPricing(modelName);
  if (!rate) return 0;
  const totIn = toSafeInt(totalInput);
  const cRead = Math.min(totIn, toSafeInt(cacheRead));
  const uncachedIn = Math.max(0, totIn - cRead);
  const out = toSafeInt(outputTokens);
  const usd = (uncachedIn * rate.inRate + cRead * rate.cacheRate + out * rate.outRate) / 1_000_000;
  return Number.isFinite(usd) && usd > 0 ? usd : 0;
}

module.exports = {
  toSafeInt,
  parseDurationSec,
  normalizeModelKey,
  shortenModelName,
  buildModelCatalog,
  lookupModelCapacity,
  parseQuotaSnapshot,
  normalizeGeneratorEntry,
  computeSessionMetrics,
  lookupModelPricing,
  estimateModelCostUsd,
};
