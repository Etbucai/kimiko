import { Module } from "@nestjs/common";
import { StoryModule } from "../story/story.module";
import { RealtimeGateway } from "./realtime.gateway";

@Module({
  imports: [StoryModule],
  providers: [RealtimeGateway],
})
export class RealtimeModule {}
