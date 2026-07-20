import { Module } from "@nestjs/common";
import { StorylineModule } from "../storyline/storyline.module";
import { RealtimeGateway } from "./realtime.gateway";

@Module({
  imports: [StorylineModule],
  providers: [RealtimeGateway],
})
export class RealtimeModule {}
