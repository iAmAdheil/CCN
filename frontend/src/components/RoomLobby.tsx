import { useState, useEffect } from "react";
import { Plus, LogOut, Video, User, Lock } from "lucide-react";
import { Room } from "@/pages/Index";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import RoomCard from "./RoomCard";
import ThemeToggle from "./ThemeToggle";

interface RoomLobbyProps {
  username: string;
  onJoinRoom: (roomName: string, password?: string) => void;
  onCreateRoom: (roomName: string, password?: string) => void;
  onLogout: () => void;
  rooms: Room[];
  passwordError: string | null;
  onPasswordErrorClear: () => void;
  pendingRoomJoin: { roomName: string; password?: string } | null;
  onPendingRoomJoin: (value: { roomName: string; password?: string } | null) => void;
}

const RoomLobby = ({
  username,
  onJoinRoom,
  onCreateRoom,
  onLogout,
  rooms,
  passwordError,
  onPasswordErrorClear,
  pendingRoomJoin,
  onPendingRoomJoin,
}: RoomLobbyProps) => {
  const [newRoomName, setNewRoomName] = useState("");
  const [newRoomPassword, setNewRoomPassword] = useState("");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [joinPassword, setJoinPassword] = useState("");
  const [joinPasswordDialogOpen, setJoinPasswordDialogOpen] = useState(false);
  const [roomToJoin, setRoomToJoin] = useState<string | null>(null);

  useEffect(() => {
    if (passwordError) {
      // Keep the password dialog open if there's an error
      setJoinPasswordDialogOpen(true);
      // Clear password input when error occurs so user can retry
      // Actually, we'll keep it - user might want to just fix a typo
    }
  }, [passwordError]);

  const handleCreateRoom = (e: React.FormEvent) => {
    e.preventDefault();
    const roomName = newRoomName.trim();
    const exists = rooms.some((room) => room.name === roomName);
    if (exists) {
      alert("Room already exists");
    } else {
      console.log("Creating room:", newRoomName);
      onCreateRoom(roomName, newRoomPassword.trim() || undefined);
      setNewRoomName("");
      setNewRoomPassword("");
      setCreateDialogOpen(false);
    }
  };

  const handleJoinClick = (roomName: string) => {
    const room = rooms.find((r) => r.name === roomName);
    if (room?.hasPassword) {
      // Room has password, show password dialog
      setRoomToJoin(roomName);
      setJoinPassword("");
      setJoinPasswordDialogOpen(true);
      onPendingRoomJoin({ roomName });
    } else {
      // No password, join directly
      onJoinRoom(roomName);
    }
  };

  const handleJoinWithPassword = () => {
    if (!roomToJoin) return;
    // Clear previous error before attempting join
    onPasswordErrorClear();
    onJoinRoom(roomToJoin, joinPassword.trim() || undefined);
    // Don't clear password here - keep it in case user wants to try again
  };

  const handlePasswordDialogClose = (open: boolean) => {
    setJoinPasswordDialogOpen(open);
    if (!open) {
      setRoomToJoin(null);
      setJoinPassword("");
      onPasswordErrorClear();
      onPendingRoomJoin(null);
    }
  };

  return (
    <div className="w-full flex-1 min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-background sticky top-0 z-50">
        <div className="container mx-auto px-3 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-foreground rounded-lg flex items-center justify-center">
                <Video className="w-4 h-4 text-background" />
              </div>
              <h1 className="text-lg font-semibold">VideoChat</h1>
            </div>
            <div className="flex items-center gap-3">
              <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-muted/50">
                <User className="w-4 h-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">{username}</span>
              </div>
              <ThemeToggle />
              <Button
                variant="ghost"
                size="sm"
                onClick={onLogout}
                className="gap-2"
              >
                <LogOut className="w-4 h-4" />
                <span className="hidden sm:inline">Logout</span>
              </Button>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-6 lg:px-8 py-8">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h2 className="text-2xl font-semibold mb-1">Rooms</h2>
            <p className="text-sm text-muted-foreground">
              {rooms.length === 0 
                ? "No active rooms yet" 
                : `${rooms.length} ${rooms.length === 1 ? "room" : "rooms"} available`}
            </p>
          </div>

          <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
            <DialogTrigger asChild>
              <Button size="sm" className="gap-2">
                <Plus className="w-4 h-4" />
                New Room
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Create Room</DialogTitle>
                <DialogDescription>
                  Enter a name for your new video chat room. Optionally add a password to protect it.
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleCreateRoom} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="room-name">Room name</Label>
                  <Input
                    id="room-name"
                    placeholder="Room name"
                    value={newRoomName}
                    onChange={(e) => setNewRoomName(e.target.value)}
                    autoFocus
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="room-password">Password (optional)</Label>
                  <Input
                    id="room-password"
                    type="password"
                    placeholder="Leave empty for public room"
                    value={newRoomPassword}
                    onChange={(e) => setNewRoomPassword(e.target.value)}
                  />
                </div>
                <Button
                  type="submit"
                  className="w-full"
                  disabled={!newRoomName.trim()}
                >
                  Create Room
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        {/* Rooms Grid */}
        {rooms.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {rooms.map((room) => (
              <RoomCard
                key={room.name}
                roomName={room.name}
                activeUsers={room.activeUsers}
                hasPassword={room.hasPassword}
                onJoin={() => handleJoinClick(room.name)}
              />
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center mb-4">
              <Video className="w-8 h-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-medium mb-2">No rooms yet</h3>
            <p className="text-sm text-muted-foreground mb-6 max-w-sm">
              Create a room to start a video call with others
            </p>
            <Button onClick={() => setCreateDialogOpen(true)} size="sm" className="gap-2">
              <Plus className="w-4 h-4" />
              Create Room
            </Button>
          </div>
        )}
      </main>

      {/* Password Dialog for Joining Protected Rooms */}
      <AlertDialog open={joinPasswordDialogOpen} onOpenChange={handlePasswordDialogClose}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Enter Room Password</AlertDialogTitle>
            <AlertDialogDescription>
              {roomToJoin ? (
                <>
                  The room <strong>{roomToJoin}</strong> is password protected. Please enter the password to join.
                </>
              ) : (
                "This room is password protected. Please enter the password to join."
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-4 py-4">
            {passwordError && (
              <Alert variant="destructive">
                <AlertDescription>{passwordError}</AlertDescription>
              </Alert>
            )}
            <div className="space-y-2">
              <Label htmlFor="join-password">Password</Label>
              <Input
                id="join-password"
                type="password"
                placeholder="Enter password"
                value={joinPassword}
                onChange={(e) => setJoinPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleJoinWithPassword();
                  }
                }}
                autoFocus
              />
            </div>
          </div>
          <AlertDialogFooter className="w-full flex flex-col gap-3">
          <Button onClick={handleJoinWithPassword}>Join Room</Button>
            <Button
              variant="outline"
              onClick={() => handlePasswordDialogClose(false)}
            >
              Cancel
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default RoomLobby;
