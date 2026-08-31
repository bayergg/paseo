// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FindInPageBar } from "./find-in-page-bar.electron";

const { eventHandlers, find, stop, theme } = vi.hoisted(() => ({
  eventHandlers: new Map<string, (payload: unknown) => void>(),
  find: vi.fn().mockResolvedValue(1),
  stop: vi.fn().mockResolvedValue(undefined),
  theme: {
    spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 },
    borderRadius: { md: 6, lg: 8, xl: 12 },
    opacity: { 50: 0.5 },
    fontSize: { xs: 11, sm: 13 },
    fontWeight: { normal: "400" },
    colors: {
      accent: "#0a84ff",
      border: "#555",
      destructive: "#ff453a",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      surface0: "#000",
      surface1: "#111",
      surface3: "#333",
      palette: { white: "#fff" },
    },
    shadow: { lg: {} },
  },
}));

vi.mock("react-native", () => ({
  ActivityIndicator: () => React.createElement("span"),
  Pressable: ({
    accessibilityLabel,
    children,
    disabled,
    onPress,
  }: {
    accessibilityLabel?: string;
    children?: React.ReactNode | ((state: { pressed: boolean }) => React.ReactNode);
    disabled?: boolean;
    onPress?: () => void;
  }) =>
    React.createElement(
      "button",
      { "aria-label": accessibilityLabel, disabled, onClick: onPress, type: "button" },
      typeof children === "function" ? children({ pressed: false }) : children,
    ),
  Text: ({
    accessibilityLiveRegion,
    children,
  }: {
    accessibilityLiveRegion?: string;
    children?: React.ReactNode;
  }) => React.createElement("span", { "aria-live": accessibilityLiveRegion }, children),
  TextInput: React.forwardRef(function TextInput(
    {
      accessibilityLabel,
      onChangeText,
      placeholder,
      testID,
      value,
    }: {
      accessibilityLabel?: string;
      onChangeText?: (value: string) => void;
      placeholder?: string;
      testID?: string;
      value?: string;
    },
    ref: React.ForwardedRef<HTMLInputElement>,
  ) {
    return React.createElement("input", {
      "aria-label": accessibilityLabel,
      "data-testid": testID,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChangeText?.(event.target.value),
      placeholder,
      ref,
      value,
    });
  }),
  View: ({
    accessibilityRole,
    children,
    testID,
  }: {
    accessibilityRole?: string;
    children?: React.ReactNode;
    testID?: string;
  }) => React.createElement("div", { "data-testid": testID, role: accessibilityRole }, children),
}));

vi.mock("lucide-react-native", () => ({
  ChevronDown: () => null,
  ChevronUp: () => null,
  X: () => null,
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: (value: typeof theme) => unknown) => factory(theme),
  },
  useUnistyles: () => ({ theme }),
}));

vi.mock("@/desktop/electron/events", () => ({
  listenToDesktopEvent: vi.fn((event: string, handler: (payload: unknown) => void) => {
    eventHandlers.set(event, handler);
    return Promise.resolve(() => eventHandlers.delete(event));
  }),
}));

vi.mock("@/desktop/host", () => ({
  getDesktopHost: () => ({ findInPage: { find, stop } }),
}));

vi.mock("@/constants/platform", () => ({ isWeb: true }));

describe("find in page bar", () => {
  beforeEach(() => {
    eventHandlers.clear();
    find.mockClear();
    stop.mockClear();
  });

  afterEach(() => cleanup());

  it("searches rendered text and supports browser navigation keys", async () => {
    const view = render(<FindInPageBar />);
    await act(async () => {});

    act(() => eventHandlers.get("find-in-page-open")?.(null));
    const input = view.getByTestId("find-in-page-input");
    fireEvent.change(input, { target: { value: "needle" } });

    expect(find).toHaveBeenCalledWith("needle", { forward: true, findNext: true });

    act(() => {
      eventHandlers.get("find-in-page-result")?.({
        requestId: 1,
        activeMatchOrdinal: 2,
        matches: 5,
        finalUpdate: true,
      });
    });
    expect(view.getByText("2/5")).toBeTruthy();

    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(find).toHaveBeenLastCalledWith("needle", { forward: false, findNext: false });

    fireEvent.keyDown(input, { key: "Escape" });
    expect(stop).toHaveBeenCalledOnce();
    expect(view.queryByTestId("find-in-page-bar")).toBeNull();

    act(() => eventHandlers.get("find-in-page-open")?.(null));
    expect(find).toHaveBeenLastCalledWith("needle", { forward: true, findNext: true });
  });
});
