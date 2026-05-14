import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Video } from "lucide-react";

interface UsernameModalProps {
  open: boolean;
  onSubmit: (username: string) => void;
}

const UsernameModal = ({ open, onSubmit }: UsernameModalProps) => {
  const [username, setUsername] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (username.trim()) {
      onSubmit(username.trim());
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
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            placeholder="Your name"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
          />
          <Button
            type="submit"
            className="w-full"
            disabled={!username.trim()}
          >
            Continue
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default UsernameModal;
