import { Global, Module } from "@nestjs/common";
import { databaseProviders } from "./database.providers";
import { DatabaseService } from "./database.service";

@Global()
@Module({
  providers: [...databaseProviders, DatabaseService],
  exports: [DatabaseService],
})
export class DatabaseModule {}
