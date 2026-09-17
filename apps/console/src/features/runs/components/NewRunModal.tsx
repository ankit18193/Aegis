import { Loader2, Sparkles, X } from "lucide-react";
import * as React from "react";

import { Button } from "../../../components/ui/Button";
import { useCreateRun } from "../hooks/useCreateRun";
import { createRunInputSchema } from "../schemas/runSchemas";

export interface NewRunModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const NewRunModal: React.FC<NewRunModalProps> = ({ isOpen, onClose }) => {
  const [goal, setGoal] = React.useState("");
  const [validationError, setValidationError] = React.useState<string | null>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  const { createRun, isPending } = useCreateRun({
    onSuccess: () => {
      setGoal("");
      setValidationError(null);
      onClose();
    },
  });

  // Focus textarea when modal opens
  React.useEffect(() => {
    if (isOpen) {
      const timer = setTimeout(() => {
        textareaRef.current?.focus();
      }, 50);
      return () => { clearTimeout(timer); };
    }
    return undefined;
  }, [isOpen]);

  // Keyboard shortcut: Escape to close
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (!isOpen) return;
      if (e.key === "Escape" && !isPending) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => { window.removeEventListener("keydown", handleKeyDown); };
  }, [isOpen, isPending, onClose]);

  if (!isOpen) return null;

  const handleSubmit = async (e?: React.FormEvent): Promise<void> => {
    if (e) e.preventDefault();
    if (isPending) return;

    const parseResult = createRunInputSchema.safeParse({ goal });
    if (!parseResult.success) {
      const firstIssue = parseResult.error.issues[0];
      setValidationError(firstIssue?.message ?? "Invalid goal");
      return;
    }

    setValidationError(null);
    try {
      await createRun(parseResult.data);
    } catch (err) {
      setValidationError(err instanceof Error ? err.message : "Failed to create run");
    }
  };

  const handleTextareaKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void handleSubmit();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs select-none"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-run-title"
      data-testid="new-run-modal"
    >
      <div
        className="w-full max-w-xl bg-surface border border-border rounded-xl shadow-2xl overflow-hidden flex flex-col transition-all"
        onClick={(e) => { e.stopPropagation(); }}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2 text-foreground font-semibold text-sm">
            <div className="w-5 h-5 rounded bg-accent/20 border border-accent/40 flex items-center justify-center text-accent">
              <Sparkles className="w-3 h-3" />
            </div>
            <h2 id="new-run-title">Create Execution Run</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isPending}
            className="text-foreground-muted hover:text-foreground p-1 rounded transition-colors focus:outline-none focus:ring-1 focus:ring-accent"
            aria-label="Close dialog"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={(e) => { void handleSubmit(e); }} className="p-5 flex flex-col gap-4">
          <div>
            <label
              htmlFor="run-goal-input"
              className="block text-xs font-medium text-foreground-muted uppercase tracking-wider font-mono mb-2"
            >
              What do you want Aegis to do?
            </label>
            <div className="relative">
              <textarea
                id="run-goal-input"
                ref={textareaRef}
                value={goal}
                onChange={(e) => {
                  setGoal(e.target.value);
                  if (validationError) setValidationError(null);
                }}
                onKeyDown={handleTextareaKeyDown}
                rows={4}
                placeholder="Analyze this repository and identify performance issues..."
                disabled={isPending}
                aria-describedby={validationError ? "goal-error" : undefined}
                className="w-full bg-surface-raised text-sm text-foreground placeholder:text-foreground-muted/60 p-3 rounded-lg border border-border focus:outline-none focus:ring-1 focus:ring-accent font-sans leading-relaxed resize-none disabled:opacity-50"
              />
            </div>
            {validationError ? (
              <p
                id="goal-error"
                className="text-xs text-rose-400 mt-1.5 font-mono"
                role="alert"
                data-testid="goal-error"
              >
                {validationError}
              </p>
            ) : null}
          </div>

          <div className="flex items-center justify-between pt-2 border-t border-border-subtle">
            <span className="text-[11px] text-foreground-muted font-mono">
              Press <kbd className="px-1.5 py-0.5 rounded bg-surface-raised border border-border-subtle text-foreground">Ctrl+Enter</kbd> to run
            </span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onClose}
                disabled={isPending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={isPending || goal.trim().length < 3}
                data-testid="submit-run-btn"
              >
                {isPending ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Creating...</span>
                  </>
                ) : (
                  <span>Run</span>
                )}
              </Button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
