import { useState } from "react";
import { RESET_CONFIRMATION, resetConsoleState } from "./api";
import { Panel } from "./components";

type ResetPhase = "idle" | "resetting" | "success" | "error";

export function ResetStateControl() {
  const [expanded, setExpanded] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [phase, setPhase] = useState<ResetPhase>("idle");
  const [message, setMessage] = useState("");
  const confirmed = confirmation === RESET_CONFIRMATION;

  const reset = async () => {
    setPhase("resetting");
    setMessage("Clearing runtime state and asking the agent for the current fleet…");
    try {
      const result = await resetConsoleState(confirmation);
      setConfirmation("");
      if (result.errors.length > 0) {
        setPhase("error");
        setMessage(`State cleared, but fleet refresh failed: ${result.errors.join("; ")}`);
      } else {
        setPhase("success");
        setMessage(`State cleared. Loaded ${result.collectors.length} current scraper(s) from Bright Data.`);
      }
      window.dispatchEvent(new Event("anansi:refresh"));
    } catch (error) {
      setPhase("error");
      setMessage((error as Error).message);
    }
  };

  return (
    <Panel>
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div className="max-w-[72ch]">
          <div className="text-[10.5px] uppercase tracking-widest" style={{ color: "var(--bad)" }}>
            Danger zone
          </div>
          <h2 className="mt-1 text-[15px] font-bold">Reset all console state</h2>
          <p className="mt-2 text-[12.5px] leading-relaxed" style={{ color: "var(--muted)" }}>
            Permanently erases incidents, runs, snapshots, audit events, job history, detector state, and heal counts.
            The agent then reloads only the current scraper identities from Bright Data. Fixture files are preserved.
          </p>
          <p className="mt-1 text-[12px]" style={{ color: "var(--warn)" }}>
            This console is open. Any visitor who can reach it can use this action.
          </p>
        </div>
        {!expanded && (
          <button
            type="button"
            className="btn-danger shrink-0 rounded-md border px-3 py-2 text-[12px] font-bold"
            style={{ borderColor: "var(--bad)", color: "var(--bad)", background: "var(--bad-soft)" }}
            onClick={() => {
              setExpanded(true);
              setPhase("idle");
              setMessage("");
            }}
          >
            Reset all state
          </button>
        )}
      </div>

      {expanded && (
        <div className="mt-4 border-t pt-4" style={{ borderColor: "var(--line)" }}>
          <label htmlFor="reset-confirmation" className="block text-[12px] font-bold">
            Type <code style={{ color: "var(--bad)" }}>{RESET_CONFIRMATION}</code> to continue
          </label>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <input
              id="reset-confirmation"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              disabled={phase === "resetting"}
              autoComplete="off"
              spellCheck={false}
              className="min-w-0 flex-1 rounded-md border px-3 py-2 text-[12px]"
              style={{ borderColor: "var(--line)", background: "var(--code-bg)", color: "var(--ink)" }}
            />
            <button
              type="button"
              className="btn-danger rounded-md border px-3 py-2 text-[12px] font-bold"
              style={{ borderColor: "var(--bad)", color: confirmed ? "var(--ink)" : "var(--muted)", background: confirmed ? "var(--bad)" : "var(--panel-2)" }}
              disabled={!confirmed || phase === "resetting"}
              onClick={() => void reset()}
            >
              {phase === "resetting" ? "Resetting…" : "Erase state and refresh fleet"}
            </button>
            <button
              type="button"
              className="btn-neutral rounded-md border px-3 py-2 text-[12px]"
              style={{ borderColor: "var(--line)", color: "var(--muted)" }}
              disabled={phase === "resetting"}
              onClick={() => {
                setExpanded(false);
                setConfirmation("");
                setPhase("idle");
                setMessage("");
              }}
            >
              Cancel
            </button>
          </div>
          {message && (
            <p
              className="mt-3 text-[12px]"
              role={phase === "error" ? "alert" : "status"}
              style={{ color: phase === "success" ? "var(--good)" : phase === "error" ? "var(--bad)" : "var(--muted)" }}
            >
              {message}
            </p>
          )}
        </div>
      )}
    </Panel>
  );
}
