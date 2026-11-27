/**
 * 歌声链路纯逻辑（ADR-005 · `V2-P3-07A`）：素材校验 + 演唱就绪判定。
 *
 * 这里只做**确定性判定**，不读文件、不调引擎、不生成音频：
 *  - WAV 头的读取与 SHA-256 由宿主侧扫描器负责，算出事实后交给本模块；
 *  - 引擎是否安装由宿主探测后交给本模块；
 *  - 本模块只回答「按契约与许可，这条链路现在能不能唱、缺什么」。
 *
 * 许可铁律（与 `V2-P3-07-svc-svs-selection.md` 一致，任何 UI 文案不得弱化）：
 *  - RVC 代码 MIT ≠ 权重可商用：官方底模「仅供研究使用」、OpenCpop 数据 CC BY-NC-ND、
 *    OpenVPI 声码器 CC BY-NC-SA → **商用必须自训底模/声库**；
 *  - 商用渠道（公开直播 / 商用分发）要求声源授权含 `commercial_livestream` 且权重许可为 `commercial_ok`；
 *  - 儿童声线没有监护人授权一律 blocker，不用「先做出来再说」。
 */
import {
  SINGING_EMOTION_MATERIAL_SPEC,
  SINGING_REQUIRED_EMOTION_KEYS,
  SINGING_TRAINING_MATERIAL_SPEC,
  type PerformanceChannel,
  type SingingEmotionKey,
  type SingingEngineKind,
  type SingingEngineProbe,
  type SingingMaterialCheck,
  type SingingMaterialFile,
  type SingingMaterialIssue,
  type SingingProfile,
  type SingingReadiness,
  type VoiceIdentity,
  type VoiceIdentitySource,
} from '@workbench/shared-protocol';

const COMMERCIAL_CHANNELS: readonly PerformanceChannel[] = [
  'livestream_public',
  'commercial_distribution',
];

/** 是否商用渠道（公开直播 / 商用分发） */
export function isCommercialChannel(channel: PerformanceChannel): boolean {
  return COMMERCIAL_CHANNELS.includes(channel);
}

function issue(
  code: SingingMaterialIssue['code'],
  severity: SingingMaterialIssue['severity'],
  message: string,
  materialId?: string,
): SingingMaterialIssue {
  return materialId === undefined ? { code, severity, message } : { code, severity, message, materialId };
}

/**
 * 单文件校验：只判**技术规格 + 授权声明缺失**，不判渠道。
 * 渠道相关的商用判定在 `resolveSingingReadiness()`，因为同一份素材在不同渠道结论不同。
 */
export function checkSingingMaterial(file: SingingMaterialFile): SingingMaterialCheck {
  const issues: SingingMaterialIssue[] = [];
  const spec = SINGING_EMOTION_MATERIAL_SPEC;

  if (file.kind === 'emotion_reference') {
    if (file.sampleRate !== spec.sampleRate) {
      issues.push(issue('sample_rate_mismatch', 'warning',
        `采样率 ${file.sampleRate}Hz ≠ 规格 ${spec.sampleRate}Hz（可重采样，但建议按规格重录）`, file.materialId));
    }
    if (file.bitDepth !== spec.bitDepth) {
      issues.push(issue('bit_depth_mismatch', 'warning',
        `位深 ${file.bitDepth}bit ≠ 规格 ${spec.bitDepth}bit`, file.materialId));
    }
    if (file.channels !== spec.channels) {
      issues.push(issue('channels_mismatch', 'warning',
        `声道数 ${file.channels} ≠ 规格 ${spec.channels}（单声道）`, file.materialId));
    }
    const delta = Math.abs(file.durationMs - spec.durationMs);
    if (delta > spec.durationToleranceMs) {
      issues.push(issue('duration_out_of_range', 'warning',
        `时长 ${file.durationMs}ms 偏离规格 ${spec.durationMs}±${spec.durationToleranceMs}ms`, file.materialId));
    }
    if (file.headSilenceMs < spec.edgeSilenceMs || file.tailSilenceMs < spec.edgeSilenceMs) {
      issues.push(issue('silence_padding_missing', 'warning',
        `头/尾静音不足 ${spec.edgeSilenceMs}ms（当前 ${file.headSilenceMs}/${file.tailSilenceMs}ms）`, file.materialId));
    }
    if (file.emotion === undefined) {
      issues.push(issue('emotion_missing', 'blocker',
        '情绪参考音必须声明属于哪一组情绪', file.materialId));
    }
  }

  if (file.kind === 'svc_training_dry_vocal') {
    if (file.durationMs < SINGING_TRAINING_MATERIAL_SPEC.minSliceMs
      || file.durationMs > SINGING_TRAINING_MATERIAL_SPEC.maxSliceMs) {
      issues.push(issue('slice_duration_out_of_range', 'warning',
        `训练干声切片 ${file.durationMs}ms 超出建议 ${SINGING_TRAINING_MATERIAL_SPEC.minSliceMs}–${SINGING_TRAINING_MATERIAL_SPEC.maxSliceMs}ms`, file.materialId));
    }
  }

  // 峰值接近 0 dBFS 视为削波（真削波不可逆，必须重录）
  if (file.peakDbfs > -0.1) {
    issues.push(issue('clipping', 'blocker',
      `峰值 ${file.peakDbfs.toFixed(1)}dBFS 已削波，必须重录`, file.materialId));
  }

  if (file.consentEvidenceRef.trim() === '') {
    issues.push(issue('consent_missing', 'blocker',
      '缺少授权声明编号（consentEvidenceRef），未授权素材不得使用', file.materialId));
  }

  return { verdict: verdictOf(issues), issues };
}

function verdictOf(issues: SingingMaterialIssue[]): SingingMaterialCheck['verdict'] {
  if (issues.some((item) => item.severity === 'blocker')) return 'fail';
  if (issues.length > 0) return 'warn';
  return 'pass';
}

export interface SingingMaterialSummary {
  verdict: SingingMaterialCheck['verdict'];
  issues: SingingMaterialIssue[];
  missingEmotionKeys: SingingEmotionKey[];
  duplicateEmotionKeys: SingingEmotionKey[];
  emotionReferenceCount: number;
  trainingTotalMs: number;
  trainingSliceCount: number;
}

/** 整份素材清单：逐文件校验 + 五组情绪覆盖 + 训练干声总时长。 */
export function summarizeSingingMaterials(
  files: readonly SingingMaterialFile[],
  requiredEmotionKeys: readonly SingingEmotionKey[] = SINGING_REQUIRED_EMOTION_KEYS,
): SingingMaterialSummary {
  const issues: SingingMaterialIssue[] = [];
  const seen = new Map<SingingEmotionKey, number>();

  for (const file of files) {
    issues.push(...checkSingingMaterial(file).issues);
    if (file.kind === 'emotion_reference' && file.emotion !== undefined) {
      seen.set(file.emotion, (seen.get(file.emotion) ?? 0) + 1);
    }
  }

  const missingEmotionKeys = requiredEmotionKeys.filter((key) => !seen.has(key));
  const duplicateEmotionKeys = [...seen.entries()]
    .filter(([, count]) => count > 1)
    .map(([key]) => key);

  for (const key of duplicateEmotionKeys) {
    issues.push(issue('emotion_duplicate', 'warning',
      `情绪组 ${key} 有 ${seen.get(key) ?? 0} 条参考音，请只保留主用一条`, undefined));
  }

  const training = files.filter((file) => file.kind === 'svc_training_dry_vocal');
  const trainingTotalMs = training.reduce((sum, file) => sum + file.durationMs, 0);
  if (training.length > 0 && trainingTotalMs < SINGING_TRAINING_MATERIAL_SPEC.minimumTotalMs) {
    issues.push(issue('total_duration_short', 'warning',
      `训练干声合计 ${Math.round(trainingTotalMs / 1000)}s，低于最低 ${SINGING_TRAINING_MATERIAL_SPEC.minimumTotalMs / 60_000} 分钟（建议 ${SINGING_TRAINING_MATERIAL_SPEC.recommendedTotalMs / 60_000} 分钟以上）`, undefined));
  }

  return {
    verdict: verdictOf(issues),
    issues,
    missingEmotionKeys,
    duplicateEmotionKeys,
    emotionReferenceCount: [...seen.values()].reduce((sum, count) => sum + count, 0),
    trainingTotalMs,
    trainingSliceCount: training.length,
  };
}

interface BlockerCollection {
  blockers: string[];
  warnings: string[];
}

const SOURCE_LABEL: Record<VoiceIdentitySource, string> = {
  builtin_reference: '随包参考音频（仅开发非商用）',
  owner_authorized_recording: 'owner 授权录音',
  licensed_model: '已授权模型',
  dev_baseline: '开发期基线',
};

/** 声音身份 + 渠道 → 授权/许可阻断项。 */
function collectVoiceBlockers(voice: VoiceIdentity, channel: PerformanceChannel): BlockerCollection {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const commercial = isCommercialChannel(channel);

  if (voice.consentEvidenceRef.trim() === '') {
    blockers.push('声音身份缺少授权声明编号（consentEvidenceRef 为空），未授权声音不得用于演唱');
  }
  if (!voice.consentScopes.includes('synthesis')) {
    blockers.push('授权范围未包含「生成合成语音（synthesis）」');
  }
  if (commercial && !voice.consentScopes.includes('commercial_livestream')) {
    blockers.push('商用/公开直播渠道要求授权范围包含「商用含直播（commercial_livestream）」');
  }
  if (voice.minorVoice && !voice.guardianConsent) {
    blockers.push('儿童声线缺少监护人授权（guardianConsent=false），不得使用');
  }
  if (commercial && (voice.source === 'dev_baseline' || voice.source === 'builtin_reference')) {
    blockers.push(`商用渠道不接受「${SOURCE_LABEL[voice.source]}」作为声源`);
  }
  if (voice.weightLicense === 'unlicensed') {
    blockers.push('权重许可为 unlicensed，任何渠道都不得使用');
  } else if (commercial && voice.weightLicense !== 'commercial_ok') {
    blockers.push('商用渠道要求权重许可为 commercial_ok：RVC 官方底模「仅供研究使用」、OpenCpop 检查点与 OpenVPI 声码器非商用 → 商用必须自训底模/声库');
  } else if (!commercial && voice.weightLicense === 'unknown') {
    warnings.push('权重许可未知（unknown），只建议内部评估，不得对外');
  } else if (!commercial && voice.weightLicense === 'dev_only_non_commercial') {
    warnings.push('权重仅限开发非商用（dev_only_non_commercial），不得进商用渠道');
  }

  return { blockers, warnings };
}

/** 路线 → 必需引擎；`svs` 还建议 OpenUtau 作前端（缺了只警告）。 */
function requiredEngines(route: SingingProfile['route']): SingingEngineKind[] {
  if (route === 'svc') return ['rvc'];
  if (route === 'svs') return ['diffsinger'];
  return ['rvc', 'diffsinger'];
}

function collectEngineBlockers(
  route: SingingProfile['route'],
  engines: readonly SingingEngineProbe[],
  channel: PerformanceChannel,
): BlockerCollection {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const byKind = new Map(engines.map((engine) => [engine.engine, engine] as const));
  const commercial = isCommercialChannel(channel);

  for (const kind of requiredEngines(route)) {
    const probe = byKind.get(kind);
    if (probe === undefined || !probe.installed) {
      const hint = probe?.hint ? `（${probe.hint}）` : '';
      blockers.push(`引擎未安装：${kind}${hint}`);
      continue;
    }
    if (commercial && probe.weightLicense !== 'commercial_ok') {
      blockers.push(`引擎 ${kind} 的权重许可为 ${probe.weightLicense}，不符合商用要求（须自训权重）`);
    }
    if (!commercial && probe.weightLicense === 'unknown') {
      warnings.push(`引擎 ${kind} 的权重许可未知，只建议内部评估`);
    }
  }

  if (route !== 'svc') {
    const front = byKind.get('openutau');
    if (front === undefined || !front.installed) {
      warnings.push('OpenUtau 未安装：SVS 仍可用 DiffSinger 直接推理，但没有编辑器/试听工作流');
    }
  }

  return { blockers, warnings };
}

function collectModelBlockers(profile: SingingProfile): string[] {
  const blockers: string[] = [];
  if (profile.route !== 'svs' && profile.voice.svcModelPath.trim() === '') {
    blockers.push('SVC 声线模型（.pth）未配置；模型来源必须可追溯（谁的声音、授权范围、训练日期）');
  }
  if (profile.route !== 'svc' && profile.voice.svsVoicebankPath.trim() === '') {
    blockers.push('SVS 声库未配置；商用需自训声库（官方 OpenCpop 检查点非商用）');
  }
  return blockers;
}

function collectMaterialBlockers(
  files: readonly SingingMaterialFile[],
  profile: SingingProfile,
): { blockers: string[]; warnings: string[]; missingEmotionKeys: SingingEmotionKey[] } {
  const summary = summarizeSingingMaterials(files);
  const missingEmotionKeys = summary.missingEmotionKeys;
  const blockers = summary.issues
    .filter((item) => item.severity === 'blocker')
    .map((item) => `素材问题：${item.message}`);
  const warnings = summary.issues
    .filter((item) => item.severity === 'warning')
    .map((item) => `素材问题：${item.message}`);

  if (missingEmotionKeys.length > 0) {
    warnings.push(`情绪参考音缺 ${missingEmotionKeys.length} 组（${missingEmotionKeys.join(' / ')}），不影响演唱，但情绪验收无法完成`);
  }

  if (profile.route !== 'svs' && files.every((file) => file.kind !== 'svc_training_dry_vocal')
    && profile.voice.source !== 'licensed_model') {
    warnings.push('没有 SVC 训练干声；若 .pth 不是自训产物，请补授权干声或改用已授权模型');
  }

  return { blockers, warnings, missingEmotionKeys };
}

export interface SingingReadinessInput {
  profile: SingingProfile;
  materials: readonly SingingMaterialFile[];
  engines: readonly SingingEngineProbe[];
  /** 当前使用的渠道；`commercialReady` 会另外按商用渠道再判一次 */
  channel: PerformanceChannel;
}

/**
 * 演唱就绪判定：零 blocker 才算 ready。
 * `commercialReady` 与 `ready` 分开，是为了让 UI 能说「能唱，但不能开播」。
 */
export function resolveSingingReadiness(input: SingingReadinessInput): SingingReadiness {
  const voice = collectVoiceBlockers(input.profile.voice, input.channel);
  const engine = collectEngineBlockers(input.profile.route, input.engines, input.channel);
  const model = collectModelBlockers(input.profile);
  const material = collectMaterialBlockers(input.materials, input.profile);

  const blockers = [...voice.blockers, ...engine.blockers, ...model, ...material.blockers];
  const warnings = dedupe([...voice.warnings, ...engine.warnings, ...material.warnings]);

  const commercialVoice = collectVoiceBlockers(input.profile.voice, 'commercial_distribution');
  const commercialEngine = collectEngineBlockers(input.profile.route, input.engines, 'commercial_distribution');
  const commercialReady = blockers.length === 0
    && commercialVoice.blockers.length === 0
    && commercialEngine.blockers.length === 0;

  return {
    ready: blockers.length === 0,
    commercialReady,
    blockers: dedupe(blockers),
    warnings,
    missingEmotionKeys: material.missingEmotionKeys,
  };
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}
