"use client";
import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession, signOut } from "next-auth/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Send,
  Loader2,
  Plus,
  MessageSquare,
  Trash2,
  LogOut,
  Menu,
  X,
  Pencil,
  Check,
} from "lucide-react";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: string[];
};

type ChatSummary = {
  id: string;
  title: string;
  updated_at: string;
};

// Renders assistant answers (which come back as markdown) with proper
// bold/italic/bullet/heading formatting instead of raw "**"/"-" characters.
function MarkdownMessage({ content }: { content: string }) {
  return (
    <div
      className="text-sm leading-relaxed [&_p]:mb-2 last:[&_p]:mb-0
        [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:mb-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:mb-2
        [&_li]:mb-1 [&_strong]:font-semibold [&_strong]:text-white [&_em]:italic
        [&_h1]:text-base [&_h1]:font-semibold [&_h1]:mb-2 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:mb-2
        [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:mb-1
        [&_code]:bg-gray-900 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-xs
        [&_a]:text-violet-400 [&_a]:underline"
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

function ChatApp() {
  const { data: session } = useSession();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);

  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [chatsLoading, setChatsLoading] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadChats();
  }, []);

  // Restore the active chat from the URL (?chat=id) once, so refreshing the
  // page keeps you on the same conversation instead of bouncing to "New chat".
  useEffect(() => {
    const chatIdFromUrl = searchParams.get("chat");
    if (chatIdFromUrl) {
      loadChat(chatIdFromUrl, { updateUrl: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  async function loadChats() {
    setChatsLoading(true);
    try {
      const res = await fetch("/api/chats");
      const data = await res.json();
      if (res.ok) setChats(data.chats || []);
    } catch (err) {
      console.error("Failed to load chats:", err);
    }
    setChatsLoading(false);
  }

  async function loadChat(id: string, opts: { updateUrl?: boolean } = {}) {
    const { updateUrl = true } = opts;
    setSidebarOpen(false);
    if (id === activeChatId) return;
    setActiveChatId(id);
    setMessages([]);
    if (updateUrl) {
      router.push(`/?chat=${id}`, { scroll: false });
    }
    try {
      const res = await fetch(`/api/chats/${id}`);
      const data = await res.json();
      if (res.ok) {
        setMessages(
          (data.messages || []).map((m: any) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            sources: m.sources || undefined,
          }))
        );
      }
    } catch (err) {
      console.error("Failed to load chat:", err);
    }
  }

  function startNewChat() {
    setActiveChatId(null);
    setMessages([]);
    setQuestion("");
    setSidebarOpen(false);
    router.push("/", { scroll: false });
  }

  async function deleteChat(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    const prevChats = chats;
    setChats((c) => c.filter((chat) => chat.id !== id));
    if (id === activeChatId) startNewChat();
    try {
      const res = await fetch(`/api/chats/${id}`, { method: "DELETE" });
      if (!res.ok) setChats(prevChats);
    } catch (err) {
      console.error("Failed to delete chat:", err);
      setChats(prevChats);
    }
  }

  function startRename(chat: ChatSummary, e: React.MouseEvent) {
    e.stopPropagation();
    setRenamingId(chat.id);
    setRenameValue(chat.title);
  }

  async function saveRename(id: string, e?: React.MouseEvent | React.FormEvent) {
    e?.stopPropagation();
    e?.preventDefault();
    const trimmed = renameValue.trim();
    setRenamingId(null);
    if (!trimmed) return;

    const prevChats = chats;
    setChats((c) => c.map((chat) => (chat.id === id ? { ...chat, title: trimmed } : chat)));

    try {
      const res = await fetch(`/api/chats/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: trimmed }),
      });
      if (!res.ok) setChats(prevChats);
    } catch (err) {
      console.error("Failed to rename chat:", err);
      setChats(prevChats);
    }
  }

  async function handleAsk() {
    const trimmed = question.trim();
    if (!trimmed || loading) return;

    const userMessage: Message = {
      id: `temp-user-${Date.now()}`,
      role: "user",
      content: trimmed,
    };
    const assistantId = `temp-assistant-${Date.now()}`;
    setMessages((m) => [
      ...m,
      userMessage,
      { id: assistantId, role: "assistant", content: "" },
    ]);
    setQuestion("");
    setLoading(true);

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: trimmed, chatId: activeChatId }),
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        setMessages((m) =>
          m.map((msg) =>
            msg.id === assistantId
              ? { ...msg, content: data.error || "Something went wrong." }
              : msg
          )
        );
        setLoading(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let fullText = "";
      let meta: { chatId: string; chatTitle: string; sources?: string[] } | null =
        null;
      // Decided once, right when the "meta" frame arrives, so both the
      // immediate sidebar insert (in the loop) and the post-loop cleanup
      // agree on whether this was a new chat or an existing one.
      const isNewChatRef = { current: null as boolean | null };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const frames = buffer.split("\n\n");
        buffer = frames.pop() || "";

        for (const frame of frames) {
          const lines = frame.split("\n");
          const eventLine = lines.find((l) => l.startsWith("event:"));
          const dataLine = lines.find((l) => l.startsWith("data:"));
          if (!eventLine || !dataLine) continue;

          const eventType = eventLine.replace("event:", "").trim();
          const data = JSON.parse(dataLine.replace("data:", "").trim());

          if (eventType === "meta") {
            meta = data;

            // Apply the sidebar update for a NEW chat right away, as soon as
            // meta arrives - not after the whole stream finishes. The
            // AI-generated "title" event can arrive before the stream ends,
            // and if the chat isn't in the `chats` list yet, that title
            // update is a silent no-op (nothing to patch), so the sidebar
            // is left showing the placeholder (the raw question) forever.
            if (isNewChatRef.current === null) {
              isNewChatRef.current = !activeChatId;
            }
            if (isNewChatRef.current) {
              setActiveChatId(data.chatId);
              router.replace(`/?chat=${data.chatId}`, { scroll: false });
              setChats((c) => [
                {
                  id: data.chatId,
                  title: data.chatTitle,
                  updated_at: new Date().toISOString(),
                },
                ...c,
              ]);
            }

            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === assistantId ? { ...msg, sources: data.sources } : msg
              )
            );
          } else if (eventType === "delta") {
            fullText += data.text;
            const snapshot = fullText;
            setMessages((m) =>
              m.map((msg) =>
                msg.id === assistantId ? { ...msg, content: snapshot } : msg
              )
            );
          } else if (eventType === "error") {
            fullText = data.message || "Something went wrong.";
            const snapshot = fullText;
            setMessages((m) =>
              m.map((msg) =>
                msg.id === assistantId ? { ...msg, content: snapshot } : msg
              )
            );
          } else if (eventType === "title") {
            setChats((c) =>
              c.map((chat) =>
                chat.id === data.chatId ? { ...chat, title: data.title } : chat
              )
            );
          }
        }
      }

      // New-chat sidebar insertion (and its sources patch) already happened
      // as soon as the "meta" frame arrived, above - that's what lets the
      // later "title" frame find the chat in the list and patch it with the
      // real AI-generated title. Here we only need to bump/re-sort an
      // EXISTING chat's updated_at, since that case has no earlier hook.
      if (meta && isNewChatRef.current === false) {
        const m = meta as { chatId: string; chatTitle: string; sources?: string[] };
        setChats((c) => {
          const updated = c.map((chat) =>
            chat.id === m.chatId
              ? { ...chat, updated_at: new Date().toISOString() }
              : chat
          );
          updated.sort(
            (a, b) =>
              new Date(b.updated_at).getTime() -
              new Date(a.updated_at).getTime()
          );
          return updated;
        });
      }
    } catch (err) {
      setMessages((m) =>
        m.map((msg) =>
          msg.id === assistantId
            ? { ...msg, content: "Something went wrong. Check the console." }
            : msg
        )
      );
    }
    setLoading(false);
  }

  return (
    <div className="h-screen flex bg-gray-950 text-white overflow-hidden">
      {/* Sidebar */}
      <aside
        className={`fixed md:static inset-y-0 left-0 z-30 w-72 shrink-0 bg-gray-900 border-r border-gray-800 flex flex-col transition-transform duration-200 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
        }`}
      >
        <div className="p-3 flex items-center gap-2">
          <button
            onClick={startNewChat}
            className="flex-1 flex items-center gap-2 px-3 py-2.5 rounded-lg border border-gray-700 hover:bg-gray-800 transition text-sm font-medium"
          >
            <Plus className="h-4 w-4" />
            New chat
          </button>
          <button
            onClick={() => setSidebarOpen(false)}
            className="md:hidden p-2 rounded-lg hover:bg-gray-800"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-1">
          {chatsLoading ? (
            <div className="flex items-center justify-center py-8 text-gray-500 text-sm gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading chats...
            </div>
          ) : chats.length === 0 ? (
            <p className="text-gray-500 text-sm px-3 py-4 text-center">
              No past chats yet. Ask something to get started.
            </p>
          ) : (
            chats.map((chat) => (
              <div
                key={chat.id}
                onClick={() => renamingId !== chat.id && loadChat(chat.id)}
                className={`group w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-left text-sm transition cursor-pointer ${
                  chat.id === activeChatId
                    ? "bg-violet-600/20 text-white"
                    : "text-gray-300 hover:bg-gray-800"
                }`}
              >
                <MessageSquare className="h-4 w-4 shrink-0 text-gray-500" />
                {renamingId === chat.id ? (
                  <form
                    onSubmit={(e) => saveRename(chat.id, e)}
                    className="flex-1 flex items-center gap-1"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={(e) => saveRename(chat.id, e)}
                      onKeyDown={(e) => e.key === "Escape" && setRenamingId(null)}
                      className="flex-1 min-w-0 bg-gray-800 border border-gray-600 rounded px-2 py-1 text-sm text-white focus:outline-none focus:ring-1 focus:ring-violet-500"
                    />
                    <button
                      type="submit"
                      className="p-1 rounded hover:bg-gray-700 text-gray-300 shrink-0"
                    >
                      <Check className="h-3.5 w-3.5" />
                    </button>
                  </form>
                ) : (
                  <>
                    <span className="flex-1 truncate">{chat.title}</span>
                    <span
                      onClick={(e) => startRename(chat, e)}
                      className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-gray-700 hover:text-violet-400 transition shrink-0"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </span>
                    <span
                      onClick={(e) => deleteChat(chat.id, e)}
                      className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-gray-700 hover:text-red-400 transition shrink-0"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </span>
                  </>
                )}
              </div>
            ))
          )}
        </div>

        {session?.user?.email && (
          <div className="p-3 border-t border-gray-800 flex items-center justify-between gap-2">
            <span className="text-xs text-gray-400 truncate">
              {session.user.email}
            </span>
            <button
              onClick={() => signOut({ callbackUrl: "/login" })}
              className="p-2 rounded-lg hover:bg-gray-800 text-gray-400 hover:text-white transition shrink-0"
              title="Sign out"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        )}
      </aside>

      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-20 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-w-0 bg-gradient-to-br from-gray-950 via-gray-900 to-violet-950">
        <header className="flex items-center gap-3 px-4 py-3 border-b border-gray-800/60 md:hidden">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-2 rounded-lg hover:bg-gray-800"
          >
            <Menu className="h-5 w-5" />
          </button>
          <h1 className="font-semibold text-sm">Harborlight HomeGuard AI</h1>
        </header>

        <div className="flex-1 overflow-y-auto">
          <div className="w-full max-w-2xl mx-auto px-4 py-10">
            {messages.length === 0 ? (
              <div className="mb-8 text-center">
                <p className="italic text-gray-400 text-sm mb-1">Zujajah Sana</p>
                <h1 className="text-3xl font-bold text-white">
                  Harborlight HomeGuard AI
                </h1>
                <p className="text-gray-400 text-sm mt-2">
                  Ask anything about your homeowners policy
                </p>
              </div>
            ) : (
              <div className="space-y-4 mb-6">
                {messages.map((m) => (
                  <div
                    key={m.id}
                    className={`flex ${
                      m.role === "user" ? "justify-end" : "justify-start"
                    }`}
                  >
                    <div
                      className={`max-w-[85%] rounded-2xl px-4 py-3 ${
                        m.role === "user"
                          ? "bg-violet-600 text-white text-sm whitespace-pre-wrap leading-relaxed"
                          : "bg-gray-800 border border-gray-700 text-gray-100"
                      }`}
                    >
                      {m.role === "assistant" ? (
                        m.content ? (
                          <MarkdownMessage content={m.content} />
                        ) : (
                          <div className="flex items-center gap-2 text-gray-400 text-sm">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            Thinking...
                          </div>
                        )
                      ) : (
                        m.content
                      )}
                    </div>
                  </div>
                ))}
                <div ref={bottomRef} />
              </div>
            )}
          </div>
        </div>

        <div className="w-full max-w-2xl mx-auto px-4 pb-8">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl shadow-xl p-3 flex flex-col sm:flex-row gap-3">
            <input
              className="flex-1 px-4 py-3 rounded-lg bg-gray-800 border border-gray-700 text-white placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-violet-500 transition"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAsk()}
              placeholder="Ask about your homeowners policy..."
            />
            <button
              onClick={handleAsk}
              disabled={loading}
              className="flex items-center justify-center gap-2 px-6 py-3 bg-violet-600 hover:bg-violet-700 disabled:opacity-60 text-white font-medium rounded-lg transition"
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Thinking...
                </>
              ) : (
                <>
                  <Send className="h-4 w-4" />
                  Ask
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <Suspense fallback={null}>
      <ChatApp />
    </Suspense>
  );
}