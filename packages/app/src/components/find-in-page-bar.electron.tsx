import { ChevronDown, ChevronUp, X } from "lucide-react-native";
import React, { useCallback, useEffect, useReducer, useRef } from "react";
import { createPortal } from "react-dom";
import { Text, TextInput, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { DESKTOP_WINDOW_CONTROLS_HEIGHT } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import { listenToDesktopEvent } from "@/desktop/electron/events";
import { getDesktopHost, type DesktopFindInPageResult } from "@/desktop/host";
import { getOverlayRoot, OVERLAY_Z } from "@/lib/overlay-root";

interface FindState {
  open: boolean;
  query: string;
  activeMatchOrdinal: number;
  matches: number;
}

type FindAction =
  | { type: "open" }
  | { type: "close" }
  | { type: "query"; query: string }
  | { type: "result"; result: DesktopFindInPageResult };

interface WebTextInputRef extends TextInput {
  getNativeElement?: () => unknown;
  getNativeRef?: () => unknown;
}

const INITIAL_STATE: FindState = {
  open: false,
  query: "",
  activeMatchOrdinal: 0,
  matches: 0,
};

function reduceFindState(state: FindState, action: FindAction): FindState {
  if (action.type === "open") {
    return { ...state, open: true, activeMatchOrdinal: 0, matches: 0 };
  }
  if (action.type === "close") return { ...state, open: false };
  if (action.type === "query") {
    return { ...state, query: action.query, activeMatchOrdinal: 0, matches: 0 };
  }
  return {
    ...state,
    activeMatchOrdinal: action.result.activeMatchOrdinal,
    matches: action.result.matches,
  };
}

function getWebTextInputElement(input: TextInput | null): HTMLElement | null {
  if (!isWeb || typeof HTMLElement === "undefined" || !input) return null;
  const webInput = input as WebTextInputRef;
  const element = webInput.getNativeElement?.() ?? webInput.getNativeRef?.() ?? input;
  return element instanceof HTMLElement ? element : null;
}

function getFindBridge() {
  const bridge = getDesktopHost()?.findInPage;
  if (!bridge) throw new Error("Desktop find in page API is unavailable.");
  return bridge;
}

export function FindInPageBar() {
  const [state, dispatch] = useReducer(reduceFindState, INITIAL_STATE);
  const inputRef = useRef<TextInput | null>(null);
  const queryRef = useRef(state.query);
  queryRef.current = state.query;

  useEffect(() => {
    let disposed = false;
    let unlisten = () => {};
    void listenToDesktopEvent("find-in-page-open", () => {
      dispatch({ type: "open" });
      if (queryRef.current) {
        void getFindBridge().find(queryRef.current, { forward: true, findNext: true });
      }
      if (!isWeb) return;
      window.requestAnimationFrame(() => {
        const input = getWebTextInputElement(inputRef.current);
        input?.focus();
        if (input instanceof HTMLInputElement) input.select();
      });
    }).then((nextUnlisten) => {
      if (disposed) nextUnlisten();
      else unlisten = nextUnlisten;
      return undefined;
    });
    return () => {
      disposed = true;
      unlisten();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten = () => {};
    void listenToDesktopEvent<DesktopFindInPageResult>("find-in-page-result", (result) => {
      dispatch({ type: "result", result });
    }).then((nextUnlisten) => {
      if (disposed) nextUnlisten();
      else unlisten = nextUnlisten;
      return undefined;
    });
    return () => {
      disposed = true;
      unlisten();
    };
  }, []);

  const continueSearch = useCallback(
    (forward: boolean): void => {
      if (!state.query) return;
      void getFindBridge().find(state.query, { forward, findNext: false });
    },
    [state.query],
  );

  const close = useCallback((): void => {
    dispatch({ type: "close" });
    void getFindBridge().stop();
  }, []);

  const updateQuery = useCallback((query: string): void => {
    dispatch({ type: "query", query });
    if (!query) {
      void getFindBridge().stop();
      return;
    }
    void getFindBridge().find(query, { forward: true, findNext: true });
  }, []);

  const findPrevious = useCallback(() => continueSearch(false), [continueSearch]);
  const findFollowing = useCallback(() => continueSearch(true), [continueSearch]);

  useEffect(() => {
    const input = getWebTextInputElement(inputRef.current);
    if (!state.open || !input) return;

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (event.key !== "Enter") return;
      event.preventDefault();
      event.stopPropagation();
      continueSearch(!event.shiftKey);
    }

    input.addEventListener("keydown", handleKeyDown);
    return () => input.removeEventListener("keydown", handleKeyDown);
  }, [close, continueSearch, state.open]);

  if (!state.open) return null;

  return createPortal(
    <View pointerEvents="box-none" style={styles.container}>
      <View accessibilityRole="search" style={styles.bar} testID="find-in-page-bar">
        <TextInput
          ref={inputRef}
          accessibilityLabel="Find in page"
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={updateQuery}
          placeholder="Find in page"
          placeholderTextColor={styles.placeholder.color}
          style={styles.input}
          testID="find-in-page-input"
          value={state.query}
        />
        <Text accessibilityLiveRegion="polite" style={styles.matchCount}>
          {state.activeMatchOrdinal}/{state.matches}
        </Text>
        <Button
          accessibilityLabel="Previous match"
          disabled={!state.query || state.matches === 0}
          leftIcon={ChevronUp}
          onPress={findPrevious}
          size="xs"
          style={styles.iconButton}
          variant="ghost"
        />
        <Button
          accessibilityLabel="Next match"
          disabled={!state.query || state.matches === 0}
          leftIcon={ChevronDown}
          onPress={findFollowing}
          size="xs"
          style={styles.iconButton}
          variant="ghost"
        />
        <Button
          accessibilityLabel="Close find"
          leftIcon={X}
          onPress={close}
          size="xs"
          style={styles.iconButton}
          variant="ghost"
        />
      </View>
    </View>,
    getOverlayRoot(),
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    position: "absolute",
    top: DESKTOP_WINDOW_CONTROLS_HEIGHT + theme.spacing[2],
    right: theme.spacing[3],
    zIndex: OVERLAY_Z.find,
  },
  bar: {
    width: 360,
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    padding: theme.spacing[2],
    backgroundColor: theme.colors.surface0,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    ...theme.shadow.lg,
  },
  input: {
    flex: 1,
    minWidth: 0,
    height: 28,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 0,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    fontSize: theme.fontSize.sm,
  },
  placeholder: {
    color: theme.colors.foregroundMuted,
  },
  matchCount: {
    minWidth: 44,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textAlign: "center",
  },
  iconButton: {
    width: 28,
    minHeight: 28,
    paddingHorizontal: 0,
  },
}));
