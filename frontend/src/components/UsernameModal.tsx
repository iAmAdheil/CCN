import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Video, Mail, ArrowLeft, Loader2 } from "lucide-react";
import { requestMagicLink, type AuthSession } from "@/lib/authClient";

interface UsernameModalProps {
  open: boolean;
  // Pre-existing identity (e.g. session restored from localStorage). When
  // present, the modal skips straight to username entry.
  initialEmail?: string;
  // Indicates that a magic-link redemption attempt failed; surface the
  // error so the user knows to try again.
  redeemError?: string | null;
  onSubmit: (username: string, email: string | null) => void;
  // Notifies the parent when a fresh session is minted by some external
  // path (e.g. magic-link redemption completed in another tab and synced
  // via storage events). Currently unused by the parent, kept here for
  // future expansion.
  onSession?: (session: AuthSession) => void;
}

type Step = "auth-choice" | "magic-sent" | "username";

const UsernameModal = ({ open, initialEmail, redeemError, onSubmit }: UsernameModalProps) => {
  const [step, setStep] = useState<Step>(initialEmail ? "username" : "auth-choice");
  const [email, setEmail] = useState(initialEmail ?? "");
  const [username, setUsername] = useState("");
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (initialEmail) {
      setEmail(initialEmail);
      setStep("username");
    }
  }, [initialEmail]);

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim().toLowerCase();
    if (!trimmed.includes("@")) {
      setLinkError("Please enter a valid email.");
      return;
    }
    setLinkBusy(true);
    setLinkError(null);
    setPreviewUrl(null);
    const result = await requestMagicLink(trimmed);
    setLinkBusy(false);
    if ("error" in result && result.error !== undefined && !result.ok) {
      setLinkError(result.error);
      return;
    }
    if (result.ok) {
      setPreviewUrl(result.previewUrl ?? null);
      setStep("magic-sent");
    }
  };

  const handleGuest = () => {
    setStep("username");
  };

  const handleUsernameSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (username.trim()) {
      onSubmit(username.trim(), email.trim() || null);
    }
  };

  return (
    <Dialog open={open}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="w-12 h-12 bg-foreground rounded-lg flex items-center justify-center mx-auto mb-4">
            <Video className="w-6 h-6 text-background" />
          </div>
          <DialogTitle className="text-center">Welcome to VideoChat</DialogTitle>
          <DialogDescription className="text-center">
            Enter your name to get started
          </DialogDescription>
        </DialogHeader>

        {step === "auth-choice" && (
          <form onSubmit={handleEmailSubmit} className="w-full flex flex-col gap-3">
            {redeemError && (
              <div className="text-xs text-destructive border border-destructive/30 rounded px-3 py-2">
                Magic link couldn't be redeemed: {redeemError}. Request a new one.
              </div>
            )}
            <div className="text-sm text-muted-foreground text-center">
              Sign in with a magic link emailed to you, or continue as a guest.
            </div>
            <div className="flex items-center gap-2">
              <Mail className="w-4 h-4 text-muted-foreground" />
              <Input
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="px-3 py-5 w-full text-sm border-1 focus:border-primary transition-colors"
                autoFocus
              />
            </div>
            {linkError && (
              <div className="text-xs text-destructive">{linkError}</div>
            )}
            <Button
              type="submit"
              className="w-full py-5 text-sm bg-purple-500 hover:bg-purple-400 disabled:opacity-50"
              disabled={linkBusy || !email.trim().includes("@")}
            >
              {linkBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : "Email me a magic link"}
            </Button>
            <div className="relative my-1">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-border/60" />
              </div>
              <div className="relative flex justify-center text-[10px] uppercase tracking-wider">
                <span className="bg-card px-2 text-muted-foreground">or</span>
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              className="w-full py-5 text-sm"
              onClick={handleGuest}
            >
              Continue as guest
            </Button>
          </form>
        )}

        {step === "magic-sent" && (
          <div className="w-full flex flex-col gap-3 text-center">
            <Mail className="w-10 h-10 mx-auto text-primary" />
            <div className="font-medium">Check your inbox</div>
            <div className="text-sm text-muted-foreground">
              We emailed a sign-in link to <span className="font-mono">{email}</span>. The link
              expires in 10 minutes.
            </div>
            {previewUrl && (
              <a
                href={previewUrl}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-primary underline break-all"
              >
                Dev preview: open mailbox
              </a>
            )}
            <Button variant="ghost" size="sm" className="w-full" onClick={() => setStep("auth-choice")}>
              <ArrowLeft className="w-3.5 h-3.5 mr-1.5" /> Use a different email
            </Button>
          </div>
        )}

        {step === "username" && (
          <form onSubmit={handleUsernameSubmit} className="w-full flex flex-col gap-4">
            {email && (
              <div className="text-xs text-muted-foreground text-center">
                Signed in as <span className="font-mono">{email}</span>
              </div>
            )}
            <Input
              placeholder="Display name"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="px-4 py-6 w-full text-base border-1 focus:border-primary transition-colors"
              autoFocus
            />
            <Button
              type="submit"
              className="w-full py-6 text-base bg-purple-500 hover:bg-purple-400 hover:opacity-90 transition-all shadow-medium hover:shadow-lg disabled:opacity-50 disabled:cursor-not-allowed duration-200"
              disabled={!username.trim()}
            >
              Continue
            </Button>
            {!initialEmail && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full"
                onClick={() => setStep("auth-choice")}
              >
                <ArrowLeft className="w-3.5 h-3.5 mr-1.5" /> Back
              </Button>
            )}
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default UsernameModal;
