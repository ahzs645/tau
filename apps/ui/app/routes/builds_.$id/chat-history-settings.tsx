import React, { useCallback, useState } from 'react';
import {
  Settings,
  DollarSign,
  File,
  Image,
  Code,
  AlertTriangle,
  AlertCircle,
  Camera,
  ListChecks,
  FolderTree,
  FileCode,
  Layers,
  ImageDown,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '#components/ui/tooltip.js';
import { Button } from '#components/ui/button.js';
import { InfoTooltip } from '#components/ui/info-tooltip.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSwitchItem,
  DropdownMenuSliderItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from '#components/ui/dropdown-menu.js';
import { useCookie } from '#hooks/use-cookie.js';
import { useImageQuality } from '#hooks/use-image-quality.js';
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
  const [includeFilesystem, setIncludeFilesystem] = useCookie(cookieName.chatCtxFs, true);
  const [includeActiveFile, setIncludeActiveFile] = useCookie(cookieName.chatCtxActive, true);
  const [includeOpenFiles, setIncludeOpenFiles] = useCookie(cookieName.chatCtxOpen, true);
  const { quality: screenshotQuality, setQuality: setScreenshotQuality } = useImageQuality();
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

  const handleIncludeFilesystemToggle = useCallback(
    (checked: boolean) => {
      setIncludeFilesystem(checked);
    },
    [setIncludeFilesystem],
  );

  const handleIncludeActiveFileToggle = useCallback(
    (checked: boolean) => {
      setIncludeActiveFile(checked);
    },
    [setIncludeActiveFile],
  );

  const handleIncludeOpenFilesToggle = useCallback(
    (checked: boolean) => {
      setIncludeOpenFiles(checked);
    },
    [setIncludeOpenFiles],
  );

  const handleScreenshotQualityChange = useCallback(
    (value: number) => {
      setScreenshotQuality(value);
    },
    [setScreenshotQuality],
  );

  const formatQualityValue = useCallback((value: number): string => {
    return `${Math.round(value * 100)}%`;
  }, []);

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
        <DropdownMenuSwitchItem isChecked={showModelCost} onIsCheckedChange={handleShowModelCostToggle}>
          <DollarSign className="size-4 stroke-2" />
          Show Model Cost
        </DropdownMenuSwitchItem>

        <DropdownMenuSeparator />

        <DropdownMenuLabel>Context Settings</DropdownMenuLabel>

        {/* Context Settings Sub-menu */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <span className="flex items-center gap-2">
              <Layers className="size-4" />
              Editor Context
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-52">
            <DropdownMenuSwitchItem isChecked={includeFilesystem} onIsCheckedChange={handleIncludeFilesystemToggle}>
              <FolderTree className="size-4" />
              Filesystem
            </DropdownMenuSwitchItem>
            <DropdownMenuSwitchItem isChecked={includeActiveFile} onIsCheckedChange={handleIncludeActiveFileToggle}>
              <FileCode className="size-4" />
              Active File
            </DropdownMenuSwitchItem>
            <DropdownMenuSwitchItem isChecked={includeOpenFiles} onIsCheckedChange={handleIncludeOpenFilesToggle}>
              <File className="size-4" />
              Open Tabs
            </DropdownMenuSwitchItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

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
            <DropdownMenuSwitchItem isChecked={showCodePreview} onIsCheckedChange={handleShowCodePreviewToggle}>
              <Code className="size-4" />
              Code Preview
            </DropdownMenuSwitchItem>
            <DropdownMenuSwitchItem isChecked={showKernelErrors} onIsCheckedChange={handleShowKernelErrorsToggle}>
              <AlertTriangle className="size-4" />
              Kernel Errors
            </DropdownMenuSwitchItem>
            <DropdownMenuSwitchItem isChecked={showCodeErrors} onIsCheckedChange={handleShowCodeErrorsToggle}>
              <AlertCircle className="size-4" />
              Linter Errors
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
            <DropdownMenuSwitchItem isChecked={showImageScreenshot} onIsCheckedChange={handleShowImageScreenshotToggle}>
              <Camera className="size-4" />
              Screenshot
            </DropdownMenuSwitchItem>
            <DropdownMenuSwitchItem
              isChecked={showImageRequirements}
              onIsCheckedChange={handleShowImageRequirementsToggle}
            >
              <ListChecks className="size-4" />
              Requirements
            </DropdownMenuSwitchItem>
            <DropdownMenuSeparator />
            <DropdownMenuSliderItem
              value={screenshotQuality}
              min={0.1}
              max={1}
              step={0.1}
              formatValue={formatQualityValue}
              infoTooltip={
                <InfoTooltip>
                  <ul className="list-disc space-y-1 pl-4">
                    <li>Lower quality: less precise, faster upload and lower LLM cost</li>
                    <li>Higher quality: more precise, slower upload and higher LLM cost</li>
                  </ul>
                </InfoTooltip>
              }
              onValueChange={handleScreenshotQualityChange}
            >
              <ImageDown />
              Quality
            </DropdownMenuSliderItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
