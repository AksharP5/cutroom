20 generated projects, Bun 1.4.4 on Linux. Both builds visited Home, requested the upstream project listing, and closed Chromium before the 30-second idle sample. Before is main 3ae36b1; After is open-project-watchers.

measure.py reads only the target server's /proc/<pid>/fdinfo and /proc/<pid>/stat. Each inotify wd row is one kernel watch. Bun shares one inotify descriptor across recursive watchers, so logical root subscriptions and kernel watches are different counts. Before: 20 project roots remain watched; 69 kernel watches and one inotify descriptor. After: no project roots, no kernel watches and no inotify descriptor.

CPU is percentage of one core over 30 seconds, from process user+system ticks. 0.30% before and 0.33% after are effectively unchanged. Total descriptors are 35 and 28 in those idle samples. Do not infer a CPU speedup.

lifecycle.json follows two real editor tabs, returning Home, an MCP edit while closed, reopening, and closing both tabs. Six watches serve one or two tabs. Closing the last releases every watch. The eight watches on reopening include app folders created by the MCP edit.
