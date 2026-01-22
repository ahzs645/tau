import { Module } from '@nestjs/common';
import { ModelModule } from '#api/models/model.module.js';
import { ToolModule } from '#api/tools/tool.module.js';
import { FileEditModule } from '#api/file-edit/file-edit.module.js';
import { AnalysisModule } from '#api/analysis/analysis.module.js';
import { ChatController } from '#api/chat/chat.controller.js';
import { ChatService } from '#api/chat/chat.service.js';
import { ChatToolsService } from '#api/chat/chat-tools.service.js';
import { ChatToolsGateway } from '#api/chat/chat-tools.gateway.js';
import { CheckpointerService } from '#api/chat/checkpointer.service.js';

@Module({
  imports: [ModelModule, ToolModule, FileEditModule, AnalysisModule],
  controllers: [ChatController],
  providers: [CheckpointerService, ChatService, ChatToolsService, ChatToolsGateway],
  exports: [ChatService, ChatToolsService],
})
export class ChatModule {}
