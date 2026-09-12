import { useEffect, useState } from "react";
import { useDetection } from "../lib/detection";
import {
  useSettings,
  DEFAULT_DETECTION_WEIGHTS,
  type DetectionWeights,
} from "../lib/settingsContext";
import { listSessions, getSignalSamples, type SessionSummary } from "../lib/db";
import { runBacktest, type BacktestResult } from "../lib/backtest";
import { formatTime } from "../lib/format";
import { SignalMeter } from "../components/SignalMeter";
import { ExcitementTimeline } from "../components/ExcitementTimeline";
import { TuningSlider } from "../components/TuningSlider";
import "./Detection.css";

const PRESETS: { label: string; weights: DetectionWeights }[] = [
  { label: "Balanced", weights: DEFAULT_DETECTION_WEIGHTS },
  { label: "Voice-heavy", weights: { voice: 1.0, chat: 0.4, motion: 0.3 } },
  { label: "Chat-heavy", weights: { voice: 0.5, chat: 1.0, motion: 0.3 } },
  { label: "Motion-heavy", weights: { voice: 0.4, chat: 0.4, motion: 1.0 } },
];

function weightsEqual(a: DetectionWeights, b: DetectionWeights): boolean {
  return a.voice === b.voice && a.chat === b.chat && a.motion === b.motion;
}

function formatSessionLabel(session: SessionSummary): string {
  const started = new Date(session.startedAt);
  const dateLabel = started.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const durationLabel = session.endedAt
    ? formatTime(
        (new Date(session.endedAt).getTime() - started.getTime()) / 1000,
      )
    : "in progress";
  return `${dateLabel} · ${durationLabel} · ${session.sampleCount} samples`;
}

export function Detection() {
  const detection = useDetection();
  const settings = useSettings();
  const {
    detectionThreshold,
    detectionCooldownMs,
    detectionWeights,
    setDetectionThreshold,
    setDetectionCooldownMs,
    setDetectionWeights,
  } = settings;

  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<number | null>(
    null,
  );
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [resultRange, setResultRange] = useState<
    { start: number; end: number } | null
  >(null);
  const [backtestError, setBacktestError] = useState<string | null>(null);

  useEffect(() => {
    listSessions()
      .then((rows) => {
        setSessions(rows);
        if (rows.length > 0) setSelectedSessionId(rows[0]!.id);
      })
      .catch((err) => console.error("[detection] failed to list sessions:", err));
  }, []);

  const runSelectedBacktest = async () => {
    if (selectedSessionId === null) return;
    setRunning(true);
    setBacktestError(null);
    try {
      const samples = await getSignalSamples(selectedSessionId);
      if (samples.length === 0) {
        setResult(null);
        setResultRange(null);
        setBacktestError("That session has no recorded signal data.");
        return;
      }
      const backtest = runBacktest(samples, {
        threshold: detectionThreshold,
        cooldownMs: detectionCooldownMs,
        weights: detectionWeights,
      });
      setResult(backtest);
      setResultRange({
        start: samples[0]!.tMs,
        end: samples[samples.length - 1]!.tMs,
      });
    } catch (err) {
      console.error("[detection] backtest failed:", err);
      setBacktestError("Backtest failed - see console.");
    } finally {
      setRunning(false);
    }
  };

  const activePreset = PRESETS.find((p) => weightsEqual(p.weights, detectionWeights));

  return (
    <div className="detection-screen">
      <div>
        <h1 className="detection-screen__title">Detection</h1>
        <p className="detection-screen__subtitle">
          Tune the weights that decide what counts as a moment, watch the
          effect live, then backtest the settings against a recorded session
          before trusting them on stream.
        </p>
      </div>

      <div className="detection-screen__card">
        <div className="detection-screen__card-header">
          <span className="detection-screen__card-title">Presets</span>
        </div>
        <div className="detection-screen__presets">
          {PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              className={
                "detection-screen__preset" +
                (activePreset?.label === preset.label
                  ? " detection-screen__preset--active"
                  : "")
              }
              onClick={() => setDetectionWeights(preset.weights)}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      <div className="detection-screen__card">
        <div className="detection-screen__card-header">
          <span className="detection-screen__card-title">Weights & threshold</span>
        </div>
        <div className="detection-screen__sliders">
          <TuningSlider
            label="Composite threshold"
            value={detectionThreshold}
            min={0.3}
            max={0.95}
            step={0.01}
            format={(v) => v.toFixed(2)}
            onCommit={setDetectionThreshold}
          />
          <TuningSlider
            label="Cooldown"
            value={detectionCooldownMs / 1000}
            min={10}
            max={120}
            step={5}
            format={(v) => `${v.toFixed(0)}s`}
            onCommit={(v) => setDetectionCooldownMs(v * 1000)}
          />
          <TuningSlider
            label="Voice weight"
            value={detectionWeights.voice}
            min={0}
            max={1}
            step={0.05}
            format={(v) => v.toFixed(2)}
            onCommit={(v) => setDetectionWeights({ ...detectionWeights, voice: v })}
          />
          <TuningSlider
            label="Chat weight"
            value={detectionWeights.chat}
            min={0}
            max={1}
            step={0.05}
            format={(v) => v.toFixed(2)}
            onCommit={(v) => setDetectionWeights({ ...detectionWeights, chat: v })}
          />
          <TuningSlider
            label="Motion weight"
            value={detectionWeights.motion}
            min={0}
            max={1}
            step={0.05}
            format={(v) => v.toFixed(2)}
            onCommit={(v) => setDetectionWeights({ ...detectionWeights, motion: v })}
          />
        </div>
      </div>

      <div className="detection-screen__card">
        <div className="detection-screen__card-header">
          <span className="detection-screen__card-title">Live preview</span>
        </div>
        <div className="detection-screen__signals">
          <SignalMeter label="Voice" value={detection.voiceScore} />
          <SignalMeter label="Chat" value={detection.chatScore} />
          <SignalMeter label="Motion" value={detection.motionScore} />
          <SignalMeter label="Composite" value={detection.composite} />
        </div>
        <ExcitementTimeline
          history={detection.history}
          marks={detection.marks}
          threshold={detectionThreshold}
        />
      </div>

      <div className="detection-screen__card">
        <div className="detection-screen__card-header">
          <span className="detection-screen__card-title">Backtest</span>
        </div>
        {sessions.length === 0 ? (
          <div className="detection-screen__mono detection-screen__mono--dim">
            No recorded sessions yet - connect to OBS or Streamlabs and stream
            for a bit, and a session will show up here to backtest against.
          </div>
        ) : (
          <>
            <div className="detection-screen__backtest-row">
              <select
                className="detection-screen__select"
                value={selectedSessionId ?? ""}
                onChange={(e) => setSelectedSessionId(Number(e.target.value))}
              >
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {formatSessionLabel(s)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="detection-screen__run-button"
                disabled={running}
                onClick={runSelectedBacktest}
              >
                {running ? "Running…" : "Run backtest"}
              </button>
            </div>
            {backtestError && (
              <div className="detection-screen__mono detection-screen__mono--dim">
                {backtestError}
              </div>
            )}
            {result && resultRange && (
              <>
                <div className="detection-screen__mono">
                  {result.marks.length} would-be clip
                  {result.marks.length === 1 ? "" : "s"} at these settings
                  over {formatTime((resultRange.end - resultRange.start) / 1000)}
                </div>
                <ExcitementTimeline
                  history={result.history}
                  marks={result.marks}
                  threshold={detectionThreshold}
                  rangeStart={resultRange.start}
                  rangeEnd={resultRange.end}
                  rangeLabel="backtested session"
                />
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
