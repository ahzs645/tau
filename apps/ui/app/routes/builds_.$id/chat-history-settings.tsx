import React, { useCallback, useState } from 'react';
import { Settings, DollarSign, File, Image, Code, AlertTriangle, AlertCircle, Camera, ListChecks } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '#components/ui/tooltip.js';
import { Button } from '#components/ui/button.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSwitchItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from '#components/ui/dropdown-menu.js';
import { useCookie } from '#hooks/use-cookie.js';
import { cookieName } from '#constants/cookie.constants.js';

/**
 * Component that provides settings for the chat history panel
 */
export function ChatHistorySettings(): React.ReactNode {
  const [showModelCost, setShowModelCost] = useCookie(cookieName.chatModelCost, true);
  const [showKernelErrors, setShowKernelErrors] = useCookie(cookieName.chatToolKernelErrors, true);
  const [showCodeErrors, setShowCodeErrors] = useCookie(cookieName.chatToolCodeErrors, true);
  const [showCodePreview, setShowCodePreview] = useCookie(cookieName.chatToolCodePreview, true);
  const [showImageScreenshot, setShowImageScreenshot] = useCookie(cookieName.chatToolImageScreenshot, true);
  const [showImageRequirements, setShowImageRequirements] = useCookie(cookieName.chatToolImageRequirements, false);
  const [isOpen, setIsOpen] = useState(false);

  const handleShowModelCostToggle = useCallback(
    (checked: boolean) => {
      setShowModelCost(checked);
    },
    [setShowModelCost],
  );

  const handleShowKernelErrorsToggle = useCallback(
    (checked: boolean) => {
      setShowKernelErrors(checked);
    },
    [setShowKernelErrors],
  );

  const handleShowCodeErrorsToggle = useCallback(
    (checked: boolean) => {
      setShowCodeErrors(checked);
    },
    [setShowCodeErrors],
  );

  const handleShowCodePreviewToggle = useCallback(
    (checked: boolean) => {
      setShowCodePreview(checked);
    },
    [setShowCodePreview],
  );

  const handleShowImageScreenshotToggle = useCallback(
    (checked: boolean) => {
      setShowImageScreenshot(checked);
    },
    [setShowImageScreenshot],
  );

  const handleShowImageRequirementsToggle = useCallback(
    (checked: boolean) => {
      setShowImageRequirements(checked);
    },
    [setShowImageRequirements],
  );

  return (
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-6 rounded-sm">
              <Settings className="size-4" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">Chat settings</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="end"
        side="bottom"
        className="w-56"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
        }}
      >
        <DropdownMenuLabel>Metadata Display</DropdownMenuLabel>
        <DropdownMenuSwitchItem
          className="flex w-full justify-between"
          isChecked={showModelCost}
          onIsCheckedChange={handleShowModelCostToggle}
        >
          <span className="flex items-center gap-2">
            <DollarSign className="size-4 stroke-2" />
            Show Model Cost
          </span>
        </DropdownMenuSwitchItem>

        <DropdownMenuSeparator />

        <DropdownMenuLabel>Tool Display Settings</DropdownMenuLabel>

        {/* File Operations Sub-menu */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <span className="flex items-center gap-2">
              <File className="size-4" />
              File Operations
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-52">
            <DropdownMenuSwitchItem
              className="flex w-full justify-between"
              isChecked={showCodePreview}
              onIsCheckedChange={handleShowCodePreviewToggle}
            >
              <span className="flex items-center gap-2">
                <Code className="size-4" />
                Code Preview
              </span>
            </DropdownMenuSwitchItem>
            <DropdownMenuSwitchItem
              className="flex w-full justify-between"
              isChecked={showKernelErrors}
              onIsCheckedChange={handleShowKernelErrorsToggle}
            >
              <span className="flex items-center gap-2">
                <AlertTriangle className="size-4" />
                Kernel Errors
              </span>
            </DropdownMenuSwitchItem>
            <DropdownMenuSwitchItem
              className="flex w-full justify-between"
              isChecked={showCodeErrors}
              onIsCheckedChange={handleShowCodeErrorsToggle}
            >
              <span className="flex items-center gap-2">
                <AlertCircle className="size-4" />
                Linter Errors
              </span>
            </DropdownMenuSwitchItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        {/* Image Analysis Sub-menu */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <span className="flex items-center gap-2">
              <Image className="size-4" />
              Image Analysis
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-52">
            <DropdownMenuSwitchItem
              className="flex w-full justify-between"
              isChecked={showImageScreenshot}
              onIsCheckedChange={handleShowImageScreenshotToggle}
            >
              <span className="flex items-center gap-2">
                <Camera className="size-4" />
                Screenshot
              </span>
            </DropdownMenuSwitchItem>
            <DropdownMenuSwitchItem
              className="flex w-full justify-between"
              isChecked={showImageRequirements}
              onIsCheckedChange={handleShowImageRequirementsToggle}
            >
              <span className="flex items-center gap-2">
                <ListChecks className="size-4" />
                Requirements
              </span>
            </DropdownMenuSwitchItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
