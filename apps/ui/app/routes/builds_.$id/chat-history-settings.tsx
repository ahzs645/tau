import React, { useCallback, useState } from 'react';
import {
  Settings,
  DollarSign,
  File,
  Code,
  FolderTree,
  FileCode,
  Layers,
  SlidersHorizontal,
  ScanEye,
  Image,
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
  const [showCodePreview, setShowCodePreview] = useCookie(cookieName.chatToolCodePreview, true);
  const [showAnalysisImages, setShowAnalysisImages] = useCookie(cookieName.chatToolAnalysisImages, true);
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

  const handleShowCodePreviewToggle = useCallback(
    (checked: boolean) => {
      setShowCodePreview(checked);
    },
    [setShowCodePreview],
  );

  const handleShowAnalysisImagesToggle = useCallback(
    (checked: boolean) => {
      setShowAnalysisImages(checked);
    },
    [setShowAnalysisImages],
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
              Preview
            </DropdownMenuSwitchItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        {/* Analysis Sub-menu */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <span className="flex items-center gap-2">
              <ScanEye className="size-4" />
              Analysis
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-52">
            <DropdownMenuLabel>Image Analysis</DropdownMenuLabel>
            <DropdownMenuSwitchItem isChecked={showAnalysisImages} onIsCheckedChange={handleShowAnalysisImagesToggle}>
              <Image className="size-4" />
              Preview
            </DropdownMenuSwitchItem>
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
              <SlidersHorizontal />
              Quality
            </DropdownMenuSliderItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
