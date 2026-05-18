import { Link, useNavigate } from 'react-router';
import { useCallback } from 'react';
import { ArrowRight } from 'lucide-react';
import type { ChatTextareaProperties } from '#components/chat/chat-textarea-types.js';
import { ChatTextarea } from '#components/chat/chat-textarea.js';
import { KernelSelector } from '#components/chat/kernel-selector.js';
import { Button } from '#components/ui/button.js';
import { ActiveChatProvider } from '#hooks/active-chat-provider.js';
import { toast } from '#components/ui/sonner.js';
import { useProjectManager } from '#hooks/use-project-manager.js';
import { useKernel } from '#hooks/use-kernel.js';
import { useActiveChatModel } from '#hooks/use-active-chat-model.js';
import { useChatActions, useChatContext } from '#hooks/use-chat.js';

function CtaChatComposer(): React.JSX.Element {
  const navigate = useNavigate();
  const { kernel, setKernel } = useKernel();
  const projectManager = useProjectManager();
  const { modelId } = useActiveChatModel();
  const { clearDraft } = useChatActions();
  const { draftActorRef } = useChatContext();

  const onSubmit: ChatTextareaProperties['onSubmit'] = useCallback(
    async ({ content, imageUrls }) => {
      try {
        const createProject = await projectManager.createProject({
          kernel,
          activeModel: modelId,
          initialMessage: { content, imageUrls },
          editorState: { panelState: { openPanels: { chat: true } } },
        });

        await navigate(`/projects/${createProject.id}`);
        clearDraft();
        draftActorRef.send({ type: 'flushNow' });
      } catch (error) {
        console.error('Failed to create project:', error);
        toast.error('Failed to create project');
      }
    },
    [kernel, modelId, projectManager, navigate, clearDraft, draftActorRef],
  );

  return (
    <div className='space-y-4'>
      <div className='flex justify-center'>
        <KernelSelector selectedKernel={kernel} onKernelChange={setKernel} />
      </div>
      <ChatTextarea
        enableAutoFocus={false}
        enableContextActions={false}
        enableKernelSelector={false}
        className='pt-1'
        onSubmit={onSubmit}
      />
    </div>
  );
}

export function CtaSection(): React.JSX.Element {
  return (
    <div className='border-t bg-linear-to-b from-muted/50 to-background'>
      <div className='container mx-auto px-4 py-20'>
        <div className='mx-auto max-w-3xl'>
          {/* Heading */}
          <div className='mb-10 text-center'>
            <h2 className='text-3xl font-semibold tracking-tight md:text-4xl'>
              We can&apos;t wait to see what you build
            </h2>
            <p className='mx-auto mt-4 max-w-xl text-muted-foreground'>
              Start designing with AI assistance, or dive straight into code.
            </p>
          </div>

          {/* Chat Input — ephemeral mode (no chatId) so the draft is held in
              memory only. The marketing CTA never persists; it just routes
              into project creation on submit. */}
          <ActiveChatProvider chatId={undefined}>
            <CtaChatComposer />
          </ActiveChatProvider>

          {/* CTA Button */}
          <div className='mt-8 flex justify-center'>
            <Button asChild size='lg' className='gap-2'>
              <Link to='/projects/new'>
                Create New Project
                <ArrowRight className='size-4' />
              </Link>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
