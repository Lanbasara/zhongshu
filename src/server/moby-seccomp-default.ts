/**
 * Moby profiles seccomp v0.2.3, Apache-2.0. Original JSON is unchanged.
 * Source: https://github.com/moby/moby/blob/8af9fe3a36bab3e039862a2ab1cef1880c9b4d03/vendor/github.com/moby/profiles/seccomp/default.json
 * Original bytes SHA-256: 536529b665dd0972c37bfb569f5d4ac8a53592e7b00752bc39ff063ca9864c74
 * Full upstream license below remains in the compiled server artifact.
 */
/*

                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.

*/
export const mobyDefaultSeccomp = {
  "defaultAction": "SCMP_ACT_ERRNO",
  "defaultErrnoRet": 1,
  "archMap": [
    {
      "architecture": "SCMP_ARCH_X86_64",
      "subArchitectures": [
        "SCMP_ARCH_X86",
        "SCMP_ARCH_X32"
      ]
    },
    {
      "architecture": "SCMP_ARCH_AARCH64",
      "subArchitectures": [
        "SCMP_ARCH_ARM"
      ]
    },
    {
      "architecture": "SCMP_ARCH_MIPS64",
      "subArchitectures": [
        "SCMP_ARCH_MIPS",
        "SCMP_ARCH_MIPS64N32"
      ]
    },
    {
      "architecture": "SCMP_ARCH_MIPS64N32",
      "subArchitectures": [
        "SCMP_ARCH_MIPS",
        "SCMP_ARCH_MIPS64"
      ]
    },
    {
      "architecture": "SCMP_ARCH_MIPSEL64",
      "subArchitectures": [
        "SCMP_ARCH_MIPSEL",
        "SCMP_ARCH_MIPSEL64N32"
      ]
    },
    {
      "architecture": "SCMP_ARCH_MIPSEL64N32",
      "subArchitectures": [
        "SCMP_ARCH_MIPSEL",
        "SCMP_ARCH_MIPSEL64"
      ]
    },
    {
      "architecture": "SCMP_ARCH_S390X",
      "subArchitectures": [
        "SCMP_ARCH_S390"
      ]
    },
    {
      "architecture": "SCMP_ARCH_RISCV64",
      "subArchitectures": null
    },
    {
      "architecture": "SCMP_ARCH_LOONGARCH64",
      "subArchitectures": null
    }
  ],
  "syscalls": [
    {
      "names": [
        "accept",
        "accept4",
        "access",
        "adjtimex",
        "alarm",
        "bind",
        "brk",
        "cachestat",
        "capget",
        "capset",
        "chdir",
        "chmod",
        "chown",
        "chown32",
        "clock_adjtime",
        "clock_adjtime64",
        "clock_getres",
        "clock_getres_time64",
        "clock_gettime",
        "clock_gettime64",
        "clock_nanosleep",
        "clock_nanosleep_time64",
        "close",
        "close_range",
        "connect",
        "copy_file_range",
        "creat",
        "dup",
        "dup2",
        "dup3",
        "epoll_create",
        "epoll_create1",
        "epoll_ctl",
        "epoll_ctl_old",
        "epoll_pwait",
        "epoll_pwait2",
        "epoll_wait",
        "epoll_wait_old",
        "eventfd",
        "eventfd2",
        "execve",
        "execveat",
        "exit",
        "exit_group",
        "faccessat",
        "faccessat2",
        "fadvise64",
        "fadvise64_64",
        "fallocate",
        "fanotify_mark",
        "fchdir",
        "fchmod",
        "fchmodat",
        "fchmodat2",
        "fchown",
        "fchown32",
        "fchownat",
        "fcntl",
        "fcntl64",
        "fdatasync",
        "fgetxattr",
        "flistxattr",
        "flock",
        "fork",
        "fremovexattr",
        "fsetxattr",
        "fstat",
        "fstat64",
        "fstatat64",
        "fstatfs",
        "fstatfs64",
        "fsync",
        "ftruncate",
        "ftruncate64",
        "futex",
        "futex_requeue",
        "futex_time64",
        "futex_wait",
        "futex_waitv",
        "futex_wake",
        "futimesat",
        "getcpu",
        "getcwd",
        "getdents",
        "getdents64",
        "getegid",
        "getegid32",
        "geteuid",
        "geteuid32",
        "getgid",
        "getgid32",
        "getgroups",
        "getgroups32",
        "getitimer",
        "getpeername",
        "getpgid",
        "getpgrp",
        "getpid",
        "getppid",
        "getpriority",
        "getrandom",
        "getresgid",
        "getresgid32",
        "getresuid",
        "getresuid32",
        "getrlimit",
        "get_robust_list",
        "getrusage",
        "getsid",
        "getsockname",
        "getsockopt",
        "get_thread_area",
        "gettid",
        "gettimeofday",
        "getuid",
        "getuid32",
        "getxattr",
        "getxattrat",
        "inotify_add_watch",
        "inotify_init",
        "inotify_init1",
        "inotify_rm_watch",
        "io_cancel",
        "ioctl",
        "io_destroy",
        "io_getevents",
        "io_pgetevents",
        "io_pgetevents_time64",
        "ioprio_get",
        "ioprio_set",
        "io_setup",
        "io_submit",
        "ipc",
        "kill",
        "landlock_add_rule",
        "landlock_create_ruleset",
        "landlock_restrict_self",
        "lchown",
        "lchown32",
        "lgetxattr",
        "link",
        "linkat",
        "listen",
        "listmount",
        "listxattr",
        "listxattrat",
        "llistxattr",
        "_llseek",
        "lremovexattr",
        "lseek",
        "lsetxattr",
        "lstat",
        "lstat64",
        "madvise",
        "map_shadow_stack",
        "membarrier",
        "memfd_create",
        "memfd_secret",
        "mincore",
        "mkdir",
        "mkdirat",
        "mknod",
        "mknodat",
        "mlock",
        "mlock2",
        "mlockall",
        "mmap",
        "mmap2",
        "mprotect",
        "mq_getsetattr",
        "mq_notify",
        "mq_open",
        "mq_timedreceive",
        "mq_timedreceive_time64",
        "mq_timedsend",
        "mq_timedsend_time64",
        "mq_unlink",
        "mremap",
        "mseal",
        "msgctl",
        "msgget",
        "msgrcv",
        "msgsnd",
        "msync",
        "munlock",
        "munlockall",
        "munmap",
        "name_to_handle_at",
        "nanosleep",
        "newfstatat",
        "_newselect",
        "open",
        "openat",
        "openat2",
        "pause",
        "pidfd_open",
        "pidfd_send_signal",
        "pipe",
        "pipe2",
        "pkey_alloc",
        "pkey_free",
        "pkey_mprotect",
        "poll",
        "ppoll",
        "ppoll_time64",
        "prctl",
        "pread64",
        "preadv",
        "preadv2",
        "prlimit64",
        "process_mrelease",
        "pselect6",
        "pselect6_time64",
        "pwrite64",
        "pwritev",
        "pwritev2",
        "read",
        "readahead",
        "readlink",
        "readlinkat",
        "readv",
        "recv",
        "recvfrom",
        "recvmmsg",
        "recvmmsg_time64",
        "recvmsg",
        "remap_file_pages",
        "removexattr",
        "removexattrat",
        "rename",
        "renameat",
        "renameat2",
        "restart_syscall",
        "riscv_hwprobe",
        "rmdir",
        "rseq",
        "rt_sigaction",
        "rt_sigpending",
        "rt_sigprocmask",
        "rt_sigqueueinfo",
        "rt_sigreturn",
        "rt_sigsuspend",
        "rt_sigtimedwait",
        "rt_sigtimedwait_time64",
        "rt_tgsigqueueinfo",
        "sched_getaffinity",
        "sched_getattr",
        "sched_getparam",
        "sched_get_priority_max",
        "sched_get_priority_min",
        "sched_getscheduler",
        "sched_rr_get_interval",
        "sched_rr_get_interval_time64",
        "sched_setaffinity",
        "sched_setattr",
        "sched_setparam",
        "sched_setscheduler",
        "sched_yield",
        "seccomp",
        "select",
        "semctl",
        "semget",
        "semop",
        "semtimedop",
        "semtimedop_time64",
        "send",
        "sendfile",
        "sendfile64",
        "sendmmsg",
        "sendmsg",
        "sendto",
        "setfsgid",
        "setfsgid32",
        "setfsuid",
        "setfsuid32",
        "setgid",
        "setgid32",
        "setgroups",
        "setgroups32",
        "setitimer",
        "setpgid",
        "setpriority",
        "setregid",
        "setregid32",
        "setresgid",
        "setresgid32",
        "setresuid",
        "setresuid32",
        "setreuid",
        "setreuid32",
        "setrlimit",
        "set_robust_list",
        "setsid",
        "setsockopt",
        "set_thread_area",
        "set_tid_address",
        "setuid",
        "setuid32",
        "setxattr",
        "setxattrat",
        "shmat",
        "shmctl",
        "shmdt",
        "shmget",
        "shutdown",
        "sigaltstack",
        "signalfd",
        "signalfd4",
        "sigprocmask",
        "sigreturn",
        "socketcall",
        "socketpair",
        "splice",
        "stat",
        "stat64",
        "statfs",
        "statfs64",
        "statmount",
        "statx",
        "symlink",
        "symlinkat",
        "sync",
        "sync_file_range",
        "syncfs",
        "sysinfo",
        "tee",
        "tgkill",
        "time",
        "timer_create",
        "timer_delete",
        "timer_getoverrun",
        "timer_gettime",
        "timer_gettime64",
        "timer_settime",
        "timer_settime64",
        "timerfd_create",
        "timerfd_gettime",
        "timerfd_gettime64",
        "timerfd_settime",
        "timerfd_settime64",
        "times",
        "tkill",
        "truncate",
        "truncate64",
        "ugetrlimit",
        "umask",
        "uname",
        "unlink",
        "unlinkat",
        "uretprobe",
        "utime",
        "utimensat",
        "utimensat_time64",
        "utimes",
        "vfork",
        "vmsplice",
        "wait4",
        "waitid",
        "waitpid",
        "write",
        "writev"
      ],
      "action": "SCMP_ACT_ALLOW"
    },
    {
      "names": [
        "process_vm_readv",
        "process_vm_writev",
        "ptrace"
      ],
      "action": "SCMP_ACT_ALLOW",
      "includes": {
        "minKernel": "4.8"
      }
    },
    {
      "names": [
        "socket"
      ],
      "action": "SCMP_ACT_ALLOW",
      "args": [
        {
          "index": 0,
          "value": 38,
          "op": "SCMP_CMP_LT"
        }
      ]
    },
    {
      "names": [
        "socket"
      ],
      "action": "SCMP_ACT_ALLOW",
      "args": [
        {
          "index": 0,
          "value": 39,
          "op": "SCMP_CMP_EQ"
        }
      ]
    },
    {
      "names": [
        "socket"
      ],
      "action": "SCMP_ACT_ALLOW",
      "args": [
        {
          "index": 0,
          "value": 40,
          "op": "SCMP_CMP_GT"
        }
      ]
    },
    {
      "names": [
        "personality"
      ],
      "action": "SCMP_ACT_ALLOW",
      "args": [
        {
          "index": 0,
          "value": 0,
          "op": "SCMP_CMP_EQ"
        }
      ]
    },
    {
      "names": [
        "personality"
      ],
      "action": "SCMP_ACT_ALLOW",
      "args": [
        {
          "index": 0,
          "value": 8,
          "op": "SCMP_CMP_EQ"
        }
      ]
    },
    {
      "names": [
        "personality"
      ],
      "action": "SCMP_ACT_ALLOW",
      "args": [
        {
          "index": 0,
          "value": 131072,
          "op": "SCMP_CMP_EQ"
        }
      ]
    },
    {
      "names": [
        "personality"
      ],
      "action": "SCMP_ACT_ALLOW",
      "args": [
        {
          "index": 0,
          "value": 131080,
          "op": "SCMP_CMP_EQ"
        }
      ]
    },
    {
      "names": [
        "personality"
      ],
      "action": "SCMP_ACT_ALLOW",
      "args": [
        {
          "index": 0,
          "value": 4294967295,
          "op": "SCMP_CMP_EQ"
        }
      ]
    },
    {
      "names": [
        "sync_file_range2",
        "swapcontext"
      ],
      "action": "SCMP_ACT_ALLOW",
      "includes": {
        "arches": [
          "ppc64le"
        ]
      }
    },
    {
      "names": [
        "arm_fadvise64_64",
        "arm_sync_file_range",
        "sync_file_range2",
        "breakpoint",
        "cacheflush",
        "set_tls"
      ],
      "action": "SCMP_ACT_ALLOW",
      "includes": {
        "arches": [
          "arm",
          "arm64"
        ]
      }
    },
    {
      "names": [
        "arch_prctl"
      ],
      "action": "SCMP_ACT_ALLOW",
      "includes": {
        "arches": [
          "amd64",
          "x32"
        ]
      }
    },
    {
      "names": [
        "modify_ldt"
      ],
      "action": "SCMP_ACT_ALLOW",
      "includes": {
        "arches": [
          "amd64",
          "x32",
          "x86"
        ]
      }
    },
    {
      "names": [
        "s390_pci_mmio_read",
        "s390_pci_mmio_write",
        "s390_runtime_instr"
      ],
      "action": "SCMP_ACT_ALLOW",
      "includes": {
        "arches": [
          "s390",
          "s390x"
        ]
      }
    },
    {
      "names": [
        "riscv_flush_icache"
      ],
      "action": "SCMP_ACT_ALLOW",
      "includes": {
        "arches": [
          "riscv64"
        ]
      }
    },
    {
      "names": [
        "open_by_handle_at"
      ],
      "action": "SCMP_ACT_ALLOW",
      "includes": {
        "caps": [
          "CAP_DAC_READ_SEARCH"
        ]
      }
    },
    {
      "names": [
        "bpf",
        "clone",
        "clone3",
        "fanotify_init",
        "fsconfig",
        "fsmount",
        "fsopen",
        "fspick",
        "lookup_dcookie",
        "lsm_get_self_attr",
        "lsm_list_modules",
        "lsm_set_self_attr",
        "mount",
        "mount_setattr",
        "move_mount",
        "open_tree",
        "perf_event_open",
        "quotactl",
        "quotactl_fd",
        "setdomainname",
        "sethostname",
        "setns",
        "syslog",
        "umount",
        "umount2",
        "unshare"
      ],
      "action": "SCMP_ACT_ALLOW",
      "includes": {
        "caps": [
          "CAP_SYS_ADMIN"
        ]
      }
    },
    {
      "names": [
        "clone"
      ],
      "action": "SCMP_ACT_ALLOW",
      "args": [
        {
          "index": 0,
          "value": 2114060288,
          "op": "SCMP_CMP_MASKED_EQ"
        }
      ],
      "excludes": {
        "caps": [
          "CAP_SYS_ADMIN"
        ],
        "arches": [
          "s390",
          "s390x"
        ]
      }
    },
    {
      "names": [
        "clone"
      ],
      "action": "SCMP_ACT_ALLOW",
      "args": [
        {
          "index": 1,
          "value": 2114060288,
          "op": "SCMP_CMP_MASKED_EQ"
        }
      ],
      "comment": "s390 parameter ordering for clone is different",
      "includes": {
        "arches": [
          "s390",
          "s390x"
        ]
      },
      "excludes": {
        "caps": [
          "CAP_SYS_ADMIN"
        ]
      }
    },
    {
      "names": [
        "clone3"
      ],
      "action": "SCMP_ACT_ERRNO",
      "errnoRet": 38,
      "excludes": {
        "caps": [
          "CAP_SYS_ADMIN"
        ]
      }
    },
    {
      "names": [
        "reboot"
      ],
      "action": "SCMP_ACT_ALLOW",
      "includes": {
        "caps": [
          "CAP_SYS_BOOT"
        ]
      }
    },
    {
      "names": [
        "chroot"
      ],
      "action": "SCMP_ACT_ALLOW",
      "includes": {
        "caps": [
          "CAP_SYS_CHROOT"
        ]
      }
    },
    {
      "names": [
        "delete_module",
        "init_module",
        "finit_module"
      ],
      "action": "SCMP_ACT_ALLOW",
      "includes": {
        "caps": [
          "CAP_SYS_MODULE"
        ]
      }
    },
    {
      "names": [
        "acct"
      ],
      "action": "SCMP_ACT_ALLOW",
      "includes": {
        "caps": [
          "CAP_SYS_PACCT"
        ]
      }
    },
    {
      "names": [
        "kcmp",
        "pidfd_getfd",
        "process_madvise",
        "process_vm_readv",
        "process_vm_writev",
        "ptrace"
      ],
      "action": "SCMP_ACT_ALLOW",
      "includes": {
        "caps": [
          "CAP_SYS_PTRACE"
        ]
      }
    },
    {
      "names": [
        "iopl",
        "ioperm"
      ],
      "action": "SCMP_ACT_ALLOW",
      "includes": {
        "caps": [
          "CAP_SYS_RAWIO"
        ]
      }
    },
    {
      "names": [
        "settimeofday",
        "stime",
        "clock_settime",
        "clock_settime64"
      ],
      "action": "SCMP_ACT_ALLOW",
      "includes": {
        "caps": [
          "CAP_SYS_TIME"
        ]
      }
    },
    {
      "names": [
        "vhangup"
      ],
      "action": "SCMP_ACT_ALLOW",
      "includes": {
        "caps": [
          "CAP_SYS_TTY_CONFIG"
        ]
      }
    },
    {
      "names": [
        "get_mempolicy",
        "mbind",
        "set_mempolicy",
        "set_mempolicy_home_node"
      ],
      "action": "SCMP_ACT_ALLOW",
      "includes": {
        "caps": [
          "CAP_SYS_NICE"
        ]
      }
    },
    {
      "names": [
        "syslog"
      ],
      "action": "SCMP_ACT_ALLOW",
      "includes": {
        "caps": [
          "CAP_SYSLOG"
        ]
      }
    },
    {
      "names": [
        "bpf"
      ],
      "action": "SCMP_ACT_ALLOW",
      "includes": {
        "caps": [
          "CAP_BPF"
        ]
      }
    },
    {
      "names": [
        "perf_event_open"
      ],
      "action": "SCMP_ACT_ALLOW",
      "includes": {
        "caps": [
          "CAP_PERFMON"
        ]
      }
    }
  ]
};
