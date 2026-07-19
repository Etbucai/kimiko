import { Global, Module } from "@nestjs/common";
import { JwtAuthGuard } from "./jwt-auth.guard";

@Global()
@Module({
  providers: [JwtAuthGuard],
  exports: [JwtAuthGuard],
})
export class AuthModule {}
