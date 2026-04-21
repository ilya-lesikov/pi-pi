import React, { useMemo } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { DiffViewer } from '../../components/DiffViewer';
import { useReviewState } from '../ReviewStateContext';
import { getReviewDiffPanelFilePath, type ReviewDiffPanelParams } from '../reviewPanelTypes';

/**
 * Thin adapter between dockview's panel API and the existing DiffViewer.
 *
 * Receives `filePath` from dockview params, reads everything else from
 * the ReviewStateContext. The existing DiffViewer component is not modified.
 */
export const ReviewDiffPanel: React.FC<IDockviewPanelProps> = (props) => {
  const state = useReviewState();
  const filePath =
    getReviewDiffPanelFilePath(props.params) ??
    getReviewDiffPanelFilePath(props.api.getParameters<ReviewDiffPanelParams>());
  const file = filePath
    ? state.files.find(candidate => candidate.path === filePath)
    : undefined;
  const isFocusedFile = !!file && state.focusedFilePath === file.path;

  const fileAnnotations = useMemo(
    () => file ? state.allAnnotations.filter((a) => a.filePath === file.path) : [],
    [state.allAnnotations, file]
  );

  const aiMessagesForFile = useMemo(
    () =>
      file
        ? state.aiMessages.filter(
            (m) => m.question.filePath === file.path
          )
        : [],
    [state.aiMessages, file]
  );

  const searchMatchesForFile = useMemo(
    () =>
      file && isFocusedFile
        ? state.activeFileSearchMatches
        : [],
    [state.activeFileSearchMatches, isFocusedFile, file]
  );

  if (!file) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
        File not found
      </div>
    );
  }

  return (
    <div key={file.path} className="h-full relative">
      <DiffViewer
        patch={file.patch}
        filePath={file.path}
        oldPath={file.oldPath}
        isFocused={isFocusedFile}
        diffStyle={state.diffStyle}
        diffOverflow={state.diffOverflow}
        diffIndicators={state.diffIndicators}
        lineDiffType={state.lineDiffType}
        disableLineNumbers={state.disableLineNumbers}
        disableBackground={state.disableBackground}
        fontFamily={state.fontFamily}
        fontSize={state.fontSize}
        annotations={fileAnnotations}
        selectedAnnotationId={state.selectedAnnotationId}
        pendingSelection={state.pendingSelection}
        onLineSelection={state.onLineSelection}
        onAddAnnotation={state.onAddAnnotation}
        onAddFileComment={state.onAddFileComment}
        onEditAnnotation={state.onEditAnnotation}
        onSelectAnnotation={state.onSelectAnnotation}
        onDeleteAnnotation={state.onDeleteAnnotation}
        isViewed={state.viewedFiles.has(file.path)}
        onToggleViewed={() => state.onToggleViewed(file.path)}
        isStaged={state.stagedFiles.has(file.path)}
        isStaging={state.stagingFile === file.path}
        onStage={() => state.onStage(file.path)}
        canStage={state.canStageFiles}
        stageError={state.stageError}
        searchQuery={state.isSearchPending ? '' : state.debouncedSearchQuery}
        searchMatches={searchMatchesForFile}
        activeSearchMatchId={isFocusedFile ? state.activeSearchMatchId : null}
        activeSearchMatch={
          isFocusedFile && state.activeSearchMatch?.filePath === file.path
            ? state.activeSearchMatch
            : null
        }
        aiAvailable={state.aiAvailable}
        onAskAI={state.onAskAI}
        isAILoading={state.isAILoading}
        onViewAIResponse={state.onViewAIResponse}
        aiMessages={aiMessagesForFile}
        onClickAIMarker={state.onClickAIMarker}
        aiHistoryMessages={isFocusedFile ? state.aiHistoryForSelection : []}
      />
    </div>
  );
};
