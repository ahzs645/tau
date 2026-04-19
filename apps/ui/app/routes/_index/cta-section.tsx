import { Link, useNavigate } from 'react-router';
import { useCallback } from 'react';
import { ArrowRight } from 'lucide-react';
import type { ChatTextareaProperties } from '#components/chat/chat-textarea-types.js';
import { ChatTextarea } from '#components/chat/chat-textarea.js';
import { KernelSelector } from '#components/chat/kernel-selector.js';
import { Button } from '#components/ui/button.js';
import { ChatProvider } from '#hooks/use-chat.js';
import { toast } from '#components/ui/sonner.js';
import { useProjectManager } from '#hooks/use-project-manager.js';
import { useKernel } from '#hooks/use-kernel.js';

export function CtaSection(): React.JSX.Element {
  const navigate = useNavigate();
  const { kernel, setKernel } = useKernel();
  const projectManager = useProjectManager();

  const onSubmit: ChatTextareaProperties['onSubmit'] = useCallback(
    async ({ content, model, metadata, imageUrls }) => {
      try {
        const createProject = await projectManager.createProject({
          kernel,
          initialMessage: { content, model, metadata, imageUrls },
          // Set initial panel state: chat open
          editorState: { panelState: { openPanels: { chat: true } } },
        });

        await navigate(`/projects/${createProject.id}`);
      } catch (error) {
        console.error('Failed to create project:', error);
        toast.error('Failed to create project');
      }
    },
    [kernel, projectManager, navigate],
  );

  return (
    <div className='border-t bg-gradient-to-b from-muted/50 to-background'>
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

          {/* Chat Input */}
          <ChatProvider>
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
          </ChatProvider>

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
