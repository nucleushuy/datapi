using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// Resource isolation, not a filesystem/network sandbox. No user-supplied program or code reaches this helper.
public static class WorkbenchAnalyticalProcess
{
    private const ulong MemoryBytes = 1073741824;
    private const uint KillOnJobClose = 0x00002000;
    private const uint JobMemory = 0x00000200;
    private const uint ProcessMemory = 0x00000100;
    private static readonly IntPtr InvalidHandle = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits
    {
        public long PerProcessUserTime, PerJobUserTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemory, PeakJobMemory;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Accounting
    {
        public long TotalUserTime, TotalKernelTime, ThisPeriodUserTime, ThisPeriodKernelTime;
        public uint PageFaultCount, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public uint Size;
        public string Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XChars, YChars, FillAttribute, Flags;
        public ushort ShowWindow, ReservedBytes;
        public IntPtr ReservedPointer, Input, Output, Error;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfoEx
    {
        public StartupInfo Startup;
        public IntPtr Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo
    {
        public IntPtr Process, Thread;
        public uint ProcessId, ThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        public int Length;
        public IntPtr Descriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool Inherit;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out Accounting info, uint size, IntPtr length);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out ExtendedLimits info, uint size, IntPtr length);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref UIntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, UIntPtr size, IntPtr previous, IntPtr returnedSize);
    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes,
        bool inheritHandles, uint flags, IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateFileW(string path, uint access, uint sharing, ref SecurityAttributes attributes, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern uint GetWindowsDirectoryW(StringBuilder path, uint size);
    [DllImport("kernel32.dll")]
    private static extern uint SetErrorMode(uint mode);

    private static void Require(bool condition)
    {
        if (!condition) throw new InvalidOperationException("Analytical resource isolation unavailable.");
    }

    // Windows CommandLineToArgvW/CRT quoting; this is never a shell command.
    private static string Quote(string value)
    {
        Require(value != null && value.IndexOf('\0') < 0);
        StringBuilder result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { slashes++; continue; }
            if (character == '"') result.Append('\\', slashes * 2 + 1);
            else result.Append('\\', slashes);
            result.Append(character);
            slashes = 0;
        }
        result.Append('\\', slashes * 2).Append('"');
        return result.ToString();
    }

    private static IntPtr WorkerEnvironment(string directory)
    {
        StringBuilder windows = new StringBuilder(32768);
        uint length = GetWindowsDirectoryW(windows, (uint)windows.Capacity);
        Require(length > 0 && length < windows.Capacity);
        string root = windows.ToString();
        SortedDictionary<string, string> values = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        values["HOME"] = directory;
        values["LOCALAPPDATA"] = directory;
        values["APPDATA"] = directory;
        values["PATH"] = Path.Combine(root, "System32");
        values["SystemRoot"] = root;
        values["TEMP"] = directory;
        values["TMP"] = directory;
        values["TZ"] = "UTC";
        values["USERPROFILE"] = directory;
        values["WINDIR"] = root;
        StringBuilder block = new StringBuilder();
        foreach (KeyValuePair<string, string> entry in values) block.Append(entry.Key).Append('=').Append(entry.Value).Append('\0');
        block.Append('\0');
        return Marshal.StringToHGlobalUni(block.ToString());
    }
    private static void CheckInterrupted(ManualResetEvent cancelled, Stopwatch deadline, int timeoutMilliseconds)
    {
        if (cancelled.WaitOne(0)) throw new OperationCanceledException();
        if (deadline.ElapsedMilliseconds >= timeoutMilliseconds) throw new TimeoutException();
    }


    public static int Run(string nodePath, string workerPath, string requestPath, int timeoutMilliseconds)
    {
        IntPtr job = IntPtr.Zero, output = IntPtr.Zero, nullFile = IntPtr.Zero;
        IntPtr attributes = IntPtr.Zero, jobList = IntPtr.Zero, handles = IntPtr.Zero, environment = IntPtr.Zero;
        bool attributesInitialized = false;
        ProcessInfo process = new ProcessInfo();
        int result = 120;
        try
        {
            Require(IntPtr.Size == 8 && timeoutMilliseconds > 0 && timeoutMilliseconds <= 300000);
            Require(Path.IsPathRooted(nodePath) && Path.IsPathRooted(workerPath) && Path.IsPathRooted(requestPath));
            Require(File.Exists(nodePath) && File.Exists(workerPath) && File.Exists(requestPath));
            string directory = Path.GetDirectoryName(requestPath);
            Require(new FileInfo(requestPath).Length <= 2 * 1024 * 1024); // PROFILE_REQUEST_BYTES; schema metadata only, never dataset rows.
            SetErrorMode(0x0001 | 0x0002 | 0x8000); // Never show native crash dialogs.

            // Parent death closes stdin, just like cancellation. The worker never inherits this control pipe.
            ManualResetEvent cancelled = new ManualResetEvent(false);
            Thread control = new Thread(delegate()
            {
                try { Console.OpenStandardInput().ReadByte(); }
                catch { }
                cancelled.Set();
            });
            control.IsBackground = true;
            control.Start();
            Stopwatch deadline = Stopwatch.StartNew();

            job = CreateJobObjectW(IntPtr.Zero, null);
            Require(job != IntPtr.Zero);
            ExtendedLimits limits = new ExtendedLimits();
            limits.Basic.Flags = KillOnJobClose | JobMemory | ProcessMemory;
            limits.JobMemoryLimit = new UIntPtr(MemoryBytes);
            limits.ProcessMemoryLimit = new UIntPtr(MemoryBytes);
            Require(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))));
            ExtendedLimits enforced;
            Require(QueryInformationJobObject(job, 9, out enforced, (uint)Marshal.SizeOf(typeof(ExtendedLimits)), IntPtr.Zero));
            Require((enforced.Basic.Flags & limits.Basic.Flags) == limits.Basic.Flags &&
                enforced.JobMemoryLimit.ToUInt64() == MemoryBytes && enforced.ProcessMemoryLimit.ToUInt64() == MemoryBytes);

            // Atomic JOB_LIST assignment avoids even an orphaned suspended child if this launcher is killed.
            UIntPtr attributeSize = UIntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref attributeSize);
            Require(attributeSize.ToUInt64() > 0 && attributeSize.ToUInt64() < 65536);
            attributes = Marshal.AllocHGlobal((int)attributeSize.ToUInt64());
            Require(InitializeProcThreadAttributeList(attributes, 2, 0, ref attributeSize));
            attributesInitialized = true;
            jobList = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobList, job);
            Require(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x0002000D), jobList, new UIntPtr((uint)IntPtr.Size), IntPtr.Zero, IntPtr.Zero));

            SecurityAttributes security = new SecurityAttributes();
            security.Length = Marshal.SizeOf(typeof(SecurityAttributes));
            security.Inherit = true;
            nullFile = CreateFileW("NUL", 0xC0000000, 3, ref security, 3, 0, IntPtr.Zero);
            Require(nullFile != InvalidHandle && nullFile != IntPtr.Zero);
            Require(DuplicateHandle(GetCurrentProcess(), GetStdHandle(-11), GetCurrentProcess(), out output, 0, true, 2));
            handles = Marshal.AllocHGlobal(IntPtr.Size * 2);
            Marshal.WriteIntPtr(handles, 0, nullFile);
            Marshal.WriteIntPtr(handles, IntPtr.Size, output);
            Require(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x00020002), handles, new UIntPtr((uint)(IntPtr.Size * 2)), IntPtr.Zero, IntPtr.Zero));

            StartupInfoEx startup = new StartupInfoEx();
            startup.Startup.Size = (uint)Marshal.SizeOf(typeof(StartupInfoEx));
            startup.Startup.Flags = 0x00000100; // STARTF_USESTDHANDLES
            startup.Startup.Input = nullFile;
            startup.Startup.Output = output;
            startup.Startup.Error = nullFile; // Never capture or forward native stderr, including crash dumps.
            startup.Attributes = attributes;
            environment = WorkerEnvironment(directory);
            StringBuilder command = new StringBuilder(Quote(nodePath) + " --disable-warning=ExperimentalWarning " + Quote(workerPath) + " " + Quote(requestPath));
            Require(command.Length < 32767);
            CheckInterrupted(cancelled, deadline, timeoutMilliseconds);
            Require(CreateProcessW(nodePath, command, IntPtr.Zero, IntPtr.Zero, true,
                0x00080000 | 0x00000400 | 0x08000000 | 0x00000004, // extended startup, Unicode env, no window, suspended
                environment, directory, ref startup, out process));
            bool assigned;
            Require(IsProcessInJob(process.Process, job, out assigned) && assigned);
            CheckInterrupted(cancelled, deadline, timeoutMilliseconds);
            {
                Require(ResumeThread(process.Thread) == 1);
                while (true)
                {
                    uint state = WaitForSingleObject(process.Process, 25);
                    if (state == 0)
                    {
                        uint code;
                        Require(GetExitCodeProcess(process.Process, out code));
                        result = code == 0 ? 0 : code == 1 ? 1 : 123;
                        break;
                    }
                    Require(state == 258);
                    CheckInterrupted(cancelled, deadline, timeoutMilliseconds);
                }
            }
        }
        catch (OperationCanceledException) { result = 122; }
        catch (TimeoutException) { result = 121; }
        catch { result = 120; }
        finally
        {
            if (job != IntPtr.Zero)
            {
                // One termination path, including successful exits: no descendant may outlive the call.
                if (!TerminateJobObject(job, 122)) result = 120;
                Stopwatch cleanup = Stopwatch.StartNew();
                while (true)
                {
                    Accounting accounting;
                    if (!QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) { result = 120; break; }
                    if (accounting.ActiveProcesses == 0) break;
                    if (cleanup.ElapsedMilliseconds >= 5000) { result = 120; break; }
                    Thread.Sleep(10);
                }
                CloseHandle(job); // KILL_ON_JOB_CLOSE is also the crash/forced-termination backstop.
            }
            if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
            if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
            if (output != IntPtr.Zero) CloseHandle(output);
            if (nullFile != IntPtr.Zero && nullFile != InvalidHandle) CloseHandle(nullFile);
            if (attributesInitialized) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
            if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
        }
        return result;
    }
}
