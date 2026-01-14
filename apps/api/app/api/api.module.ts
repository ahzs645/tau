import { Module } from '@nestjs/common';
import { AnalysisModule } from '#api/analysis/analysis.module.js';
import { ChatModule } from '#api/chat/chat.module.js';
import { CodeCompletionModule } from '#api/code-completion/code-completion.module.js';
import { FileEditModule } from '#api/file-edit/file-edit.module.js';
import { KernelsModule } from '#api/kernels/kernels.module.js';
import { ModelModule } from '#api/models/model.module.js';
import { PrivacyModule } from '#api/privacy/privacy.module.js';
import { ProviderModule } from '#api/providers/provider.module.js';
import { TestApiModule } from '#api/test-api/test-api.module.js';
import { ToolModule } from '#api/tools/tool.module.js';
import { WebSocketModule } from '#api/websocket/websocket.module.js';

@Module({
  imports: [
    // Shared infrastructure modules
    WebSocketModule,

    // Production modules
    AnalysisModule,
    ChatModule,
    CodeCompletionModule,
    FileEditModule,
    KernelsModule,
    ModelModule,
    PrivacyModule,
    ProviderModule,
    ToolModule,

    // Testing modules
    ...(import.meta.env.DEV ? [TestApiModule] : []),
  ],
})
export class ApiModule {}
