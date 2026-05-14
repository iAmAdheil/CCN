import { Users, ArrowRight, Lock } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

interface RoomCardProps {
  roomName: string;
  activeUsers: {
    id: string;
    username: string;
  }[];
  hasPassword: boolean;
  onJoin: () => void;
}

const RoomCard = ({ roomName, activeUsers, hasPassword, onJoin }: RoomCardProps) => {
  return (
    <Card className="group hover:border-foreground/20 transition-colors">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base font-medium truncate">
            {roomName}
          </CardTitle>
          {hasPassword && (
            <Lock className="w-4 h-4 text-muted-foreground flex-shrink-0" />
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Users className="w-4 h-4" />
            <span>
              {activeUsers.length} {activeUsers.length === 1 ? "person" : "people"}
            </span>
          </div>
          {activeUsers.length > 0 && (
            <div className="flex -space-x-2">
              {activeUsers.slice(0, 3).map((user, index) => (
                <Avatar key={index} className="w-6 h-6 border-2 border-background">
                  <AvatarFallback className="text-xs">
                    {user.username.charAt(0).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
              ))}
              {activeUsers.length > 3 && (
                <div className="w-6 h-6 rounded-full border-2 border-background bg-muted flex items-center justify-center">
                  <span className="text-[10px] font-medium">
                    +{activeUsers.length - 3}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
        <Button
          onClick={onJoin}
          size="sm"
          className="w-full gap-2"
        >
          Join
          <ArrowRight className="w-4 h-4" />
        </Button>
      </CardContent>
    </Card>
  );
};

export default RoomCard;
