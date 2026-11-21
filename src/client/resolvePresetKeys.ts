// Edit-page and global shortcuts from the Resolve preset Cutroom follows.
const keysByModifier = {
  "": "' , - . / 1 2 3 4 5 6 7 8 9 ; = A B Backspace C D Delete Down E End F F10 F11 F12 F9 G Home I K Left M Numpad= NumpadAdd NumpadSubtract O P Q R Right S Space T U Up V W X Y Z [ ] `",
  Alt: ", . / 0 1 2 3 4 5 6 7 8 9 B Down E F F1 F2 F3 F4 F5 F6 F7 F8 F9 H I L Left M O P Q R Right T U Up V W X Y \\ ]",
  "Alt+Shift":
    ", - . / 0 1 2 3 4 5 6 7 8 9 = D F1 F2 F3 F4 F5 F6 F7 F8 F9 G I Left O Q Right V X Z [ \\ ]",
  Ctrl: ", - / 1 2 3 4 5 6 7 9 = A C D Down E F F1 F2 F3 F4 F5 F6 F7 F8 F9 I K Left M N P Q R Right S T Up V X Y Z [ \\ ]",
  "Ctrl+Alt":
    "' , - . / 1 2 3 4 5 6 7 8 9 ; = B Down F F1 F2 F3 F4 F5 F6 F7 F8 F9 G I K L Left N O R Right S Up X Y",
  "Ctrl+Shift":
    ", . / 1 2 3 4 5 6 7 8 9 = A Down F1 F2 F3 F4 F5 F6 F7 F8 F9 I L Left N O Right S Up V W X Z",
  Shift:
    ", . / 1 2 3 4 5 6 7 8 9 = A Backspace C D Down E F F10 F11 F12 H I J K L Left M O Q R Right S Space T Up V W X Z [ ] `",
};

export const resolvePresetKeys = new Set(
  Object.entries(keysByModifier).flatMap(([modifier, keys]) =>
    keys.split(" ").map((key) => (modifier ? `${modifier}+${key}` : key)),
  ),
);
