/**
 * RemixCopilot — AI Co-Pilot Chat Panel for Remix Studio (Phase 4).
 *
 * Slide-out panel that shows Claude's suggestions for improving clips.
 * Supports SSE streaming for real-time responses, suggestion cards with
 * "Apply" / "Dismiss" buttons, and freeform chat input.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  MessageSquare, Send, Loader2, X, Sparkles, Scissors,
  ArrowRight, ChevronRight, Clock, Zap, Image, Layers,
  Type, Monitor, AlertTriangle, Lightbulb, CheckCircle2,
  XCircle
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

// ── Types ──────────────────────────────────────────────────────────

interface CopilotSuggestion {
  type: string;
  reason: string;
  confidence: number;
  data: Record<string, any>;
}

interface CopilotMessage {
  id: string;
  role: "assistant" | "user";
  content: string;
  suggestions?: CopilotSuggestion[];
  followUpQuestions?: string[];
  timestamp: number;
}

interface RemixCopilotProps {
  videoId: number;
  clipId?: number;
  open: boolean;
  onClose: () => void;
  onApplySuggestion?: (suggestion: CopilotSuggestion) => void;
  /** When true, renders as an inline panel (inside Remix Studio) instead of a fixed overlay */
  inline?: boolean;
}

// ── Suggestion Type Config ─────────────────────────────────────────

const SUGGESTION_ICONS: Record<string, any> = {
  trim: Scissors,
  hook_improvement: Zap,
  add_placement: Image,
  generate_asset: Sparkles,
  stitch: Layers,
  caption_edit: Type,
  platform_switch: Monitor,
  reject: AlertTriangle,
};

const SUGGESTION_COLORS: Record<string, string> = {
  trim: "border-blue-500/30 bg-blue-500/10",
  hook_improvement: "border-amber-500/30 bg-amber-500/10",
  add_placement: "border-green-500/30 bg-green-500/10",
  generate_asset: "border-purple-500/30 bg-purple-500/10",
  stitch: "border-cyan-500/30 bg-cyan-500/10",
  caption_edit: "border-pink-500/30 bg-pink-500/10",
  platform_switch: "border-orange-500/30 bg-orange-500/10",
  reject: "border-red-500/30 bg-red-500/10",
};

const SUGGESTION_LABELS: Record<string, string> = {
  trim: "Trim Clip",
  hook_improvement: "Better Hook",
  add_placement: "Add Placement",
  generate_asset: "Generate Asset",
  stitch: "Stitch Segments",
  caption_edit: "Edit Captions",
  platform_switch: "Switch Platform",
  reject: "Quality Issue",
};

// ── Component ──────────────────────────────────────────────────────

export default function RemixCopilot({
  videoId,
  clipId,
  open,
  onClose,
  onApplySuggestion,
  inline = false,
}: RemixCopilotProps) {
  const [messages, setMessages] = useState<CopilotMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [dismissedSuggestions, setDismissedSuggestions] = useState<Set<string>>(new Set());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Scroll to bottom when messages update
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Focus input when panel opens
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 300);
    }
  }, [open]);

  // ── Send Message (SSE Streaming) ─────────────────────────────────

  const sendMessage = useCallback(async (
    userMessage: string,
    trigger: "user_question" | "post_generation" | "post_trim" | "low_score" = "user_question"
  ) => {
    if (isStreaming) return;
    if (trigger === "user_question" && !userMessage.trim()) return;

    // Add user message to chat
    if (userMessage.trim()) {
      const userMsg: CopilotMessage = {
        id: `user_${Date.now()}`,
        role: "user",
        content: userMessage.trim(),
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, userMsg]);
    }
    setInput("");
    setIsStreaming(true);

    // Create assistant message placeholder
    const assistantId = `assistant_${Date.now()}`;
    const assistantMsg: CopilotMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      suggestions: [],
      followUpQuestions: [],
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, assistantMsg]);

    try {
      const response = await fetch(`/api/remix/${videoId}/copilot/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          trigger,
          userMessage: userMessage.trim() || undefined,
          clipId: clipId || undefined,
        }),
      });

      if (!response.ok) {
        // Try to extract error message from response body
        let errorMsg = `HTTP ${response.status}`;
        try {
          const errBody = await response.json();
          errorMsg = errBody.error || errorMsg;
        } catch {}
        throw new Error(errorMsg);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process SSE events from buffer
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // keep incomplete line in buffer

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();

          if (data === "[DONE]") continue;

          try {
            const parsed = JSON.parse(data);

            if (parsed.type === "text") {
              // Append streaming text
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === assistantId
                    ? { ...msg, content: msg.content + parsed.data }
                    : msg
                )
              );
            } else if (parsed.type === "done") {
              // Final structured response
              const final = JSON.parse(parsed.data);
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === assistantId
                    ? {
                        ...msg,
                        content: final.message || msg.content,
                        suggestions: final.suggestions || [],
                        followUpQuestions: final.followUpQuestions || [],
                      }
                    : msg
                )
              );
            }
          } catch {
            // Skip malformed SSE events
          }
        }
      }
    } catch (err: any) {
      console.error("[RemixCopilot] Error:", err);
      const errMsg = err.message || "Unknown error";
      // Show the specific error from the server if available
      const displayMsg = errMsg.includes("API key") || errMsg.includes("not configured")
        ? errMsg
        : `Sorry, I encountered an error: ${errMsg}. Please try again.`;
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantId
            ? { ...msg, content: displayMsg }
            : msg
        )
      );
    } finally {
      setIsStreaming(false);
    }
  }, [videoId, clipId, isStreaming]);

  // ── Handle Suggestion Actions ────────────────────────────────────

  const handleApply = useCallback((suggestion: CopilotSuggestion) => {
    if (onApplySuggestion) {
      onApplySuggestion(suggestion);
    }
  }, [onApplySuggestion]);

  const handleDismiss = useCallback((suggestionKey: string) => {
    setDismissedSuggestions((prev) => new Set([...prev, suggestionKey]));
  }, []);

  const handleFollowUp = useCallback((question: string) => {
    sendMessage(question);
  }, [sendMessage]);

  // ── Render ───────────────────────────────────────────────────────

  // Shared panel content (used for both inline and overlay modes)
  const panelContent = (
    <>
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-gray-800">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-cyan-500 flex items-center justify-center">
            <Sparkles className="w-4 h-4 text-white" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-white">AI Co-Pilot</h3>
            <p className="text-xs text-gray-500">Remix optimization assistant</p>
          </div>
        </div>
        {!inline && (
          <Button variant="ghost" size="icon" onClick={onClose} className="text-gray-400 hover:text-white">
            <X className="w-4 h-4" />
          </Button>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center px-4">
            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-violet-500/20 to-cyan-500/20 flex items-center justify-center mb-3">
              <Sparkles className="w-7 h-7 text-violet-400" />
            </div>
            <h4 className="text-white font-medium mb-1.5 text-sm">AI Remix Co-Pilot</h4>
            <p className="text-gray-500 text-xs mb-4">
              Optimize clips, suggest trims, placements & platform targeting.
            </p>
            <div className="space-y-2 w-full">
              {[
                "How can I improve my clip's hook?",
                "Which platform is best for this clip?",
                "Suggest a highlight reel from this video",
              ].map((q) => (
                <button
                  key={q}
                  onClick={() => sendMessage(q)}
                  className="w-full text-left px-3 py-2 rounded-lg bg-gray-800/50 hover:bg-gray-800 text-gray-400 hover:text-white text-xs transition-colors border border-gray-700/50"
                >
                  <Lightbulb className="w-3 h-3 inline mr-2 text-amber-500" />
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[90%] rounded-xl px-3 py-2 ${
                msg.role === "user"
                  ? "bg-violet-600 text-white"
                  : "bg-gray-800 text-gray-200"
              }`}
            >
              {/* Message text */}
              <p className="text-sm whitespace-pre-wrap">{msg.content}</p>

              {/* Streaming indicator */}
              {msg.role === "assistant" && isStreaming && msg === messages[messages.length - 1] && !msg.suggestions?.length && (
                <div className="flex items-center gap-1 mt-1">
                  <Loader2 className="w-3 h-3 animate-spin text-violet-400" />
                  <span className="text-xs text-gray-500">Thinking...</span>
                </div>
              )}

              {/* Suggestions */}
              {msg.suggestions && msg.suggestions.length > 0 && (
                <div className="mt-3 space-y-2">
                  {msg.suggestions.map((sug, idx) => {
                    const key = `${msg.id}_${idx}`;
                    if (dismissedSuggestions.has(key)) return null;

                    const Icon = SUGGESTION_ICONS[sug.type] || Lightbulb;
                    const colorClass = SUGGESTION_COLORS[sug.type] || "border-gray-500/30 bg-gray-500/10";
                    const label = SUGGESTION_LABELS[sug.type] || sug.type;

                    return (
                      <div key={key} className={`rounded-lg border p-3 ${colorClass}`}>
                        <div className="flex items-center gap-2 mb-1">
                          <Icon className="w-3.5 h-3.5" />
                          <span className="text-xs font-medium">{label}</span>
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0 ml-auto">
                            {(sug.confidence * 100).toFixed(0)}%
                          </Badge>
                        </div>
                        <p className="text-xs text-gray-400 mb-2">{sug.reason}</p>

                        {/* Type-specific preview */}
                        <SuggestionPreview suggestion={sug} />

                        {/* Action buttons */}
                        <div className="flex items-center gap-2 mt-2">
                          <Button
                            size="sm"
                            className="h-6 text-[10px] px-2 bg-violet-600 hover:bg-violet-500"
                            onClick={() => handleApply(sug)}
                          >
                            <CheckCircle2 className="w-3 h-3 mr-1" /> Apply
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 text-[10px] px-2 text-gray-500 hover:text-gray-300"
                            onClick={() => handleDismiss(key)}
                          >
                            <XCircle className="w-3 h-3 mr-1" /> Dismiss
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Follow-up questions */}
              {msg.followUpQuestions && msg.followUpQuestions.length > 0 && (
                <div className="mt-3 space-y-1">
                  {msg.followUpQuestions.map((q, idx) => (
                    <button
                      key={idx}
                      onClick={() => handleFollowUp(q)}
                      disabled={isStreaming}
                      className="w-full text-left text-xs text-violet-400 hover:text-violet-300 flex items-center gap-1 disabled:opacity-50"
                    >
                      <ChevronRight className="w-3 h-3" />
                      {q}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-gray-800 p-3">
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage(input);
              }
            }}
            placeholder="Ask about your clip..."
            disabled={isStreaming}
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-violet-500 disabled:opacity-50"
          />
          <Button
            size="icon"
            onClick={() => sendMessage(input)}
            disabled={isStreaming || !input.trim()}
            className="bg-violet-600 hover:bg-violet-500 disabled:opacity-50"
          >
            {isStreaming ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </Button>
        </div>
        <p className="text-[10px] text-gray-600 mt-1.5 text-center">
          AI suggestions are recommendations — review before applying
        </p>
      </div>
    </>
  );

  // Inline mode: render as a normal div that fills its parent container
  if (inline) {
    return (
      <div className="w-full h-full bg-gray-900 flex flex-col">
        {panelContent}
      </div>
    );
  }

  // Overlay mode: fixed slide-out panel from the right
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-y-0 right-0 w-96 bg-gray-900 border-l border-gray-800 shadow-2xl z-50 flex flex-col"
          initial={{ x: "100%" }}
          animate={{ x: 0 }}
          exit={{ x: "100%" }}
          transition={{ type: "spring", damping: 25, stiffness: 200 }}
        >
          {panelContent}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ── Suggestion Preview Sub-component ────────────────────────────────

function SuggestionPreview({ suggestion }: { suggestion: CopilotSuggestion }) {
  const { type, data } = suggestion;

  switch (type) {
    case "trim":
      return (
        <div className="text-[10px] text-gray-400 bg-gray-900/50 rounded px-2 py-1.5 font-mono">
          <div className="flex justify-between">
            <span>New start: {data.newStart?.toFixed(1)}s</span>
            <span className={data.trimDelta?.startDelta > 0 ? "text-red-400" : "text-green-400"}>
              ({data.trimDelta?.startDelta > 0 ? "+" : ""}{data.trimDelta?.startDelta?.toFixed(1)}s)
            </span>
          </div>
          <div className="flex justify-between">
            <span>New end: {data.newEnd?.toFixed(1)}s</span>
            <span className={data.trimDelta?.endDelta > 0 ? "text-green-400" : "text-red-400"}>
              ({data.trimDelta?.endDelta > 0 ? "+" : ""}{data.trimDelta?.endDelta?.toFixed(1)}s)
            </span>
          </div>
        </div>
      );

    case "hook_improvement":
      return (
        <div className="text-[10px] text-gray-400 bg-gray-900/50 rounded px-2 py-1.5">
          <span className="text-amber-400">Start at {data.alternativeStart?.toFixed(1)}s</span>
          {data.hookLine && (
            <p className="mt-0.5 italic">"{data.hookLine}"</p>
          )}
        </div>
      );

    case "add_placement":
      return (
        <div className="text-[10px] text-gray-400 bg-gray-900/50 rounded px-2 py-1.5">
          Place <span className="text-green-400 font-medium">{data.productName}</span> on
          surface #{data.surfaceId} at {data.placementTimestamp?.toFixed(1)}s
        </div>
      );

    case "generate_asset":
      return (
        <div className="text-[10px] text-gray-400 bg-gray-900/50 rounded px-2 py-1.5">
          <Badge variant="outline" className="text-[9px] mb-1">{data.assetType}</Badge>
          <p className="italic">"{data.prompt}"</p>
        </div>
      );

    case "stitch":
      return (
        <div className="text-[10px] text-gray-400 bg-gray-900/50 rounded px-2 py-1.5 space-y-0.5">
          {data.additionalSegments?.map((seg: any, i: number) => (
            <div key={i} className="flex items-center gap-1">
              <ArrowRight className="w-2.5 h-2.5 text-cyan-400" />
              <span>{seg.start?.toFixed(1)}s → {seg.end?.toFixed(1)}s</span>
              <span className="text-gray-600 ml-1">({seg.reason})</span>
            </div>
          ))}
          <div className="text-cyan-400 mt-0.5">Transition: {data.suggestedTransition}</div>
        </div>
      );

    case "platform_switch":
      return (
        <div className="text-[10px] text-gray-400 bg-gray-900/50 rounded px-2 py-1.5">
          <span className="text-orange-400">{data.currentPlatform}</span>
          {" → "}
          <span className="text-green-400 font-medium">{data.betterPlatform}</span>
          {data.platformReasons?.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {data.platformReasons.slice(0, 3).map((r: string, i: number) => (
                <li key={i} className="flex items-start gap-1">
                  <span className="text-gray-600">•</span> {r}
                </li>
              ))}
            </ul>
          )}
        </div>
      );

    case "caption_edit":
      return (
        <div className="text-[10px] text-gray-400 bg-gray-900/50 rounded px-2 py-1.5">
          Style: <span className="text-pink-400 font-medium">{data.suggestedStyle}</span>
          {data.keyMoments?.length > 0 && (
            <div className="mt-1 space-y-0.5">
              {data.keyMoments.slice(0, 3).map((m: any, i: number) => (
                <div key={i}>{m.time?.toFixed(1)}s: "{m.text}"</div>
              ))}
            </div>
          )}
        </div>
      );

    case "reject":
      return (
        <div className="text-[10px] bg-gray-900/50 rounded px-2 py-1.5">
          <ul className="text-red-400 space-y-0.5">
            {data.issues?.map((issue: string, i: number) => (
              <li key={i} className="flex items-start gap-1">
                <AlertTriangle className="w-2.5 h-2.5 mt-0.5 flex-shrink-0" /> {issue}
              </li>
            ))}
          </ul>
          {data.fixable && (
            <p className="text-green-400 mt-1">✓ These issues are fixable</p>
          )}
        </div>
      );

    default:
      return null;
  }
}
