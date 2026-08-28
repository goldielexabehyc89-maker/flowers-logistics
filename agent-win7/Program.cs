/*
 * Пилотный агент печати наклеек для Windows 7 SP1.
 *
 * ЗАЧЕМ ОТДЕЛЬНАЯ СБОРКА. Современный агент — это Node 24 (single executable),
 * а Node не запускается на Windows 7 начиная с версии выше 14. Единственный
 * поддерживаемый на Windows 7 SP1 runtime — .NET Framework 4.8. Он же даёт
 * системный TLS (SChannel) с настоящей проверкой сертификата, доступ к
 * системному спулеру через winspool и защищённое хранение токена через DPAPI.
 *
 * ТОЛЬКО app.erpget.ru. Прямое TLS-рукопожатие Windows 7 с production
 * (erpget.ru, Caddy) невозможно: у них нет ни одного общего шифра — Windows 7
 * умеет только CBC-наборы, а сервер отдаёт только AES-GCM и ChaCha20. Обратный
 * прокси app.erpget.ru (nginx) принимает CBC-набор ECDHE-RSA-AES256-SHA384,
 * который Windows 7 поддерживает, и это тот же production через ту же базу.
 * Поэтому endpoint у legacy-агента ровно один и зашит в код: запасного
 * подключения к erpget.ru нет.
 *
 * ПРОВЕРКУ СЕРТИФИКАТА НЕ ОТКЛЮЧАЕМ. Валидация цепочки остаётся штатной
 * (SChannel + хранилище корней Windows). Ничего в системных настройках агент
 * молча не меняет: если TLS 1.2 выключен или нет доверия к ISRG Root X1, он
 * показывает инструкцию, а решение принимает человек.
 *
 * ГЛАВНОЕ ПРАВИЛО: лучше не напечатать, чем напечатать дважды. Любой неясный
 * исход сообщается серверу как «unknown», и такое задание больше не выдаётся
 * автоматически. Отметка о переданном заданию ставится ДО обращения к спулеру,
 * поэтому выключенный посреди печати компьютер при следующем запуске честно
 * скажет «исход неизвестен», а не напечатает наклейку второй раз.
 *
 * СЕКРЕТЫ В ЖУРНАЛ НЕ ВЫВОДЯТСЯ. Ни код подключения, ни токен нигде не печатаются.
 */

using System;
using System.Collections.Generic;
using System.Drawing.Printing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32;

namespace FlowersPrintAgent
{
    internal static class Program
    {
        /// Единственный допустимый адрес legacy-агента. Запасного нет.
        private const string AllowedHost = "app.erpget.ru";
        private const string DefaultServerUrl = "https://app.erpget.ru";

        /// Сколько идентификаторов помнить: журнал не должен расти вечно.
        private const int JournalLimit = 500;

        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

        private static string StateDir
        {
            get
            {
                var overridden = Environment.GetEnvironmentVariable("AGENT_STATE_DIR");
                if (!string.IsNullOrEmpty(overridden))
                {
                    return overridden;
                }
                var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                // Отдельный каталог от современного агента: две сборки не делят
                // ни настройки, ни журнал.
                return Path.Combine(local, "flowers-print-agent-win7");
            }
        }

        private static string ConfigPath { get { return Path.Combine(StateDir, "config.json"); } }
        private static string JournalPath { get { return Path.Combine(StateDir, "processed.log"); } }
        private static string PendingPath { get { return Path.Combine(StateDir, "pending.json"); } }
        private static string ErrorPath { get { return Path.Combine(StateDir, "last-error.txt"); } }

        private static int Main(string[] args)
        {
            // Windows 7 SChannel умеет только TLS 1.2 из современных версий;
            // 1.3 у него нет вовсе. Форсируем 1.2 и НЕ трогаем проверку
            // сертификата — колбэк валидации остаётся системным.
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;

            try
            {
                var command = args.Length > 0 ? args[0] : "";

                if (command == "--check")
                {
                    return Preflight(true) ? 0 : 1;
                }

                if (command == "--setup" || ReadConfig() == null)
                {
                    if (!Preflight(true))
                    {
                        Console.Error.WriteLine("\nОкружение не готово: исправьте отмеченное выше и повторите.");
                        return 1;
                    }
                    Setup();
                    if (command == "--setup")
                    {
                        return 0;
                    }
                }

                if (!Preflight(false))
                {
                    Console.Error.WriteLine("\nОкружение не готово: запустите flowers-print-agent-win7.exe --check.");
                    return 1;
                }

                RunLoop();
                return 0;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine("\nОшибка: " + error.Message);
                RememberError(error.Message);
                return 1;
            }
        }

        private static void Log(string message)
        {
            Console.WriteLine(DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ") + "  " + message);
        }

        // --- Проверки окружения --------------------------------------------------

        /// Проверяет Windows 7 SP1, .NET 4.8, TLS 1.2 и доверие к ISRG Root X1.
        /// `verbose` печатает подробности; возвращает true, если критические
        /// проверки пройдены. Системные настройки не меняются.
        private static bool Preflight(bool verbose)
        {
            var ok = true;

            // 1. Операционная система.
            string product, servicePack;
            ReadWindowsVersion(out product, out servicePack);
            if (product.IndexOf("Windows 7", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                if (servicePack.IndexOf("Service Pack 1", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    if (verbose) Console.WriteLine("  ОС: " + product + " (SP1) — ок");
                }
                else
                {
                    ok = false;
                    Console.WriteLine("  ОС: " + product + " БЕЗ SP1.");
                    Console.WriteLine("      Установите Service Pack 1 (KB976932) и повторите.");
                }
            }
            else if (Environment.OSVersion.Version.Major < 6 ||
                     (Environment.OSVersion.Version.Major == 6 && Environment.OSVersion.Version.Minor < 1))
            {
                ok = false;
                Console.WriteLine("  ОС: " + product + " — старее Windows 7. Агент не поддерживается.");
            }
            else
            {
                // Более новая Windows: это legacy-сборка, обычно её ставят на
                // Windows 7. На современной системе пользуйтесь обычным агентом,
                // но запуску это не мешает — проверка проходит.
                if (verbose) Console.WriteLine("  ОС: " + product + " — это legacy-сборка для Windows 7; на современной системе используйте обычный агент.");
            }

            // 2. .NET Framework 4.8 (или новее).
            var release = DotNetRelease();
            if (release >= 528040)
            {
                if (verbose) Console.WriteLine("  .NET Framework: 4.8+ (release " + release + ") — ок");
            }
            else
            {
                ok = false;
                Console.WriteLine("  .NET Framework: 4.8 не найден (release " + release + ").");
                Console.WriteLine("      Установите .NET Framework 4.8 для Windows 7 SP1 и повторите.");
            }

            // 3. TLS 1.2 + доверие сертификату — одним настоящим запросом к
            //    app.erpget.ru. Успех означает, что и TLS 1.2, и цепочка
            //    (включая ISRG Root X1) в порядке.
            var tls = CheckHttps();
            if (tls == null)
            {
                if (verbose) Console.WriteLine("  TLS 1.2 и сертификат " + AllowedHost + ": ок");
            }
            else
            {
                ok = false;
                Console.WriteLine("  TLS/сертификат " + AllowedHost + ": " + tls);
            }

            // 4. Явная подсказка про корень (диагностика к пункту 3).
            var rootFound = HasIsrgRootX1();
            if (verbose)
            {
                Console.WriteLine(rootFound
                    ? "  Корень ISRG Root X1: найден в хранилище доверенных корней"
                    : "  Корень ISRG Root X1: НЕ найден. Если пункт TLS не прошёл — установите этот корень (Пуск → certmgr.msc → «Доверенные корневые центры»), не отключая проверку.");
            }

            return ok;
        }

        private static void ReadWindowsVersion(out string product, out string servicePack)
        {
            product = "Windows (версия не прочитана)";
            servicePack = "";
            try
            {
                using (var key = RegistryKey
                           .OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Default)
                           .OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion"))
                {
                    if (key != null)
                    {
                        var name = key.GetValue("ProductName") as string;
                        if (!string.IsNullOrEmpty(name)) product = name;
                        var csd = key.GetValue("CSDVersion") as string;
                        if (!string.IsNullOrEmpty(csd)) servicePack = csd;
                    }
                }
            }
            catch
            {
                // Реестр недоступен — оставляем значения по умолчанию.
            }
        }

        private static int DotNetRelease()
        {
            try
            {
                using (var key = RegistryKey
                           .OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Default)
                           .OpenSubKey(@"SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full"))
                {
                    if (key != null)
                    {
                        var value = key.GetValue("Release");
                        if (value is int) return (int)value;
                    }
                }
            }
            catch
            {
            }
            return 0;
        }

        /// Возвращает null при успехе, иначе — понятную причину с инструкцией.
        private static string CheckHttps()
        {
            try
            {
                var request = (HttpWebRequest)WebRequest.Create(DefaultServerUrl + "/");
                request.Method = "GET";
                request.Timeout = 20000;
                request.UserAgent = "flowers-print-agent-win7";
                using (var response = (HttpWebResponse)request.GetResponse())
                {
                    // Любой ответ означает успешное TLS-рукопожатие и валидную
                    // цепочку: до кода состояния дело доходит только после них.
                    var _ = response.StatusCode;
                    return null;
                }
            }
            catch (WebException error)
            {
                if (error.Response is HttpWebResponse)
                {
                    // Пришёл HTTP-ответ (например, 404) — TLS и сертификат в порядке.
                    return null;
                }
                if (error.Status == WebExceptionStatus.TrustFailure)
                {
                    return "сертификат не доверен. Установите корень ISRG Root X1 в «Доверенные корневые центры» (certmgr.msc). Проверку НЕ отключать.";
                }
                if (error.Status == WebExceptionStatus.SecureChannelFailure)
                {
                    return "рукопожатие TLS не удалось. Включите TLS 1.2 (KB3140245 и параметр SystemDefaultTlsVersions) и убедитесь, что установлен Service Pack 1.";
                }
                return "нет соединения (" + error.Status + "). Проверьте интернет и доступ к " + AllowedHost + ".";
            }
            catch (Exception error)
            {
                return error.Message;
            }
        }

        private static bool HasIsrgRootX1()
        {
            foreach (var location in new[] { StoreLocation.LocalMachine, StoreLocation.CurrentUser })
            {
                try
                {
                    using (var store = new X509Store(StoreName.Root, location))
                    {
                        store.Open(OpenFlags.ReadOnly);
                        foreach (var cert in store.Certificates)
                        {
                            if (cert.Subject.IndexOf("ISRG Root X1", StringComparison.OrdinalIgnoreCase) >= 0)
                            {
                                return true;
                            }
                        }
                    }
                }
                catch
                {
                }
            }
            return false;
        }

        // --- Хранение настроек ---------------------------------------------------

        // Свойства, а не поля: JavaScriptSerializer заполняет при десериализации
        // именно публичные свойства.
        private sealed class AgentConfig
        {
            public string serverUrl { get; set; }
            public string printerName { get; set; }
            public string pointId { get; set; }
            public string token { get; set; } // base64 DPAPI-защищённого значения
        }

        private static AgentConfig ReadConfig()
        {
            if (!File.Exists(ConfigPath))
            {
                return null;
            }
            var text = File.ReadAllText(ConfigPath, Encoding.UTF8);
            return Json.Deserialize<AgentConfig>(text);
        }

        private static void WriteConfig(AgentConfig config)
        {
            Directory.CreateDirectory(StateDir);
            File.WriteAllText(ConfigPath, Json.Serialize(config), new UTF8Encoding(false));
        }

        private static string ProtectToken(string token)
        {
            var bytes = ProtectedData.Protect(
                Encoding.UTF8.GetBytes(token), null, DataProtectionScope.CurrentUser);
            return Convert.ToBase64String(bytes);
        }

        private static string UnprotectToken(string stored)
        {
            var bytes = ProtectedData.Unprotect(
                Convert.FromBase64String(stored), null, DataProtectionScope.CurrentUser);
            return Encoding.UTF8.GetString(bytes);
        }

        // --- Журнал --------------------------------------------------------------

        private static HashSet<string> ProcessedJobs()
        {
            var set = new HashSet<string>(StringComparer.Ordinal);
            if (File.Exists(JournalPath))
            {
                foreach (var line in File.ReadAllLines(JournalPath))
                {
                    var trimmed = line.Trim();
                    if (trimmed.Length > 0) set.Add(trimmed);
                }
            }
            return set;
        }

        private static void RememberJob(string jobId)
        {
            Directory.CreateDirectory(StateDir);
            File.AppendAllText(JournalPath, jobId + Environment.NewLine);

            var all = new List<string>(ProcessedJobs());
            if (all.Count > JournalLimit)
            {
                var keep = all.GetRange(all.Count - JournalLimit, JournalLimit);
                File.WriteAllText(JournalPath, string.Join(Environment.NewLine, keep) + Environment.NewLine);
            }
        }

        private static void MarkPending(string jobId)
        {
            Directory.CreateDirectory(StateDir);
            var payload = new Dictionary<string, object>
            {
                { "jobId", jobId },
                { "at", DateTime.UtcNow.ToString("o") }
            };
            File.WriteAllText(PendingPath, Json.Serialize(payload));
        }

        private static void ClearPending()
        {
            if (File.Exists(PendingPath))
            {
                File.WriteAllText(PendingPath, "");
            }
        }

        private static string ReadPendingJobId()
        {
            if (!File.Exists(PendingPath))
            {
                return null;
            }
            var raw = File.ReadAllText(PendingPath).Trim();
            if (raw.Length == 0)
            {
                return null;
            }
            var parsed = Json.Deserialize<Dictionary<string, object>>(raw);
            object jobId;
            return parsed != null && parsed.TryGetValue("jobId", out jobId) ? jobId as string : null;
        }

        private static void RememberError(string text)
        {
            try
            {
                Directory.CreateDirectory(StateDir);
                File.WriteAllText(ErrorPath, DateTime.UtcNow.ToString("o") + Environment.NewLine + text + Environment.NewLine);
            }
            catch
            {
            }
        }

        // --- Печать через системный спулер --------------------------------------

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private sealed class DOCINFO
        {
            [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
            [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
            [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
        }

        [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool OpenPrinter(string src, out IntPtr hPrinter, IntPtr pd);

        [DllImport("winspool.drv", SetLastError = true)]
        private static extern bool ClosePrinter(IntPtr hPrinter);

        [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool StartDocPrinter(IntPtr hPrinter, int level,
            [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFO di);

        [DllImport("winspool.drv", SetLastError = true)]
        private static extern bool EndDocPrinter(IntPtr hPrinter);

        [DllImport("winspool.drv", SetLastError = true)]
        private static extern bool StartPagePrinter(IntPtr hPrinter);

        [DllImport("winspool.drv", SetLastError = true)]
        private static extern bool EndPagePrinter(IntPtr hPrinter);

        [DllImport("winspool.drv", SetLastError = true)]
        private static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);

        /// Передаёт готовые байты TSPL принтеру СЫРЫМ потоком, мимо драйвера.
        /// Драйвер пересобрал бы кадр и сместил наклейку; спулер типа RAW
        /// отдаёт принтеру ровно то, что собрал сервер.
        private static void SendToPrinter(string printerName, byte[] bytes)
        {
            // Путь разработки: вместо принтера — файл. Тот же протокол и журнал.
            if (printerName.StartsWith("file:", StringComparison.Ordinal))
            {
                var directory = printerName.Substring("file:".Length);
                Directory.CreateDirectory(directory);
                var file = Path.Combine(directory, "job-" + DateTime.UtcNow.Ticks + "-" + bytes.Length + ".bin");
                File.WriteAllBytes(file, bytes);
                Log("  задание записано в " + file);
                return;
            }

            IntPtr handle;
            if (!OpenPrinter(printerName, out handle, IntPtr.Zero))
            {
                throw new Exception("OpenPrinter: " + Marshal.GetLastWin32Error());
            }
            try
            {
                var info = new DOCINFO { pDocName = "Flowers label", pDataType = "RAW" };
                if (!StartDocPrinter(handle, 1, info))
                {
                    throw new Exception("StartDocPrinter: " + Marshal.GetLastWin32Error());
                }
                try
                {
                    if (!StartPagePrinter(handle))
                    {
                        throw new Exception("StartPagePrinter: " + Marshal.GetLastWin32Error());
                    }
                    var buffer = Marshal.AllocCoTaskMem(bytes.Length);
                    try
                    {
                        Marshal.Copy(bytes, 0, buffer, bytes.Length);
                        int written;
                        if (!WritePrinter(handle, buffer, bytes.Length, out written))
                        {
                            throw new Exception("WritePrinter: " + Marshal.GetLastWin32Error());
                        }
                        if (written != bytes.Length)
                        {
                            throw new Exception("WritePrinter: передано " + written + " из " + bytes.Length);
                        }
                    }
                    finally
                    {
                        Marshal.FreeCoTaskMem(buffer);
                    }
                    EndPagePrinter(handle);
                }
                finally
                {
                    EndDocPrinter(handle);
                }
            }
            finally
            {
                ClosePrinter(handle);
            }
        }

        private static List<string> InstalledPrinters()
        {
            var names = new List<string>();
            foreach (string name in PrinterSettings.InstalledPrinters)
            {
                names.Add(name);
            }
            return names;
        }

        // --- Обмен с сервером ----------------------------------------------------

        private static Dictionary<string, object> CallServer(string serverUrl, string path, object body, string token)
        {
            var request = (HttpWebRequest)WebRequest.Create(new Uri(new Uri(serverUrl), path));
            request.Method = "POST";
            request.ContentType = "application/json";
            request.Timeout = 30000;
            request.UserAgent = "flowers-print-agent-win7";
            if (!string.IsNullOrEmpty(token))
            {
                request.Headers["Authorization"] = "Bearer " + token;
            }

            var payload = Encoding.UTF8.GetBytes(Json.Serialize(body ?? new Dictionary<string, object>()));
            using (var stream = request.GetRequestStream())
            {
                stream.Write(payload, 0, payload.Length);
            }

            try
            {
                using (var response = (HttpWebResponse)request.GetResponse())
                using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                {
                    var text = reader.ReadToEnd();
                    return string.IsNullOrEmpty(text) ? new Dictionary<string, object>() : Json.Deserialize<Dictionary<string, object>>(text);
                }
            }
            catch (WebException error)
            {
                var http = error.Response as HttpWebResponse;
                if (http != null)
                {
                    // Токен и код в текст ошибки не попадают: показываем только код.
                    throw new Exception(path + ": HTTP " + (int)http.StatusCode);
                }
                throw new Exception(path + ": " + error.Status);
            }
        }

        // --- Настройка при первом запуске ---------------------------------------

        private static void Setup()
        {
            Console.WriteLine("\nНастройка агента печати (Windows 7)\n");
            Console.WriteLine("Адрес сервера для legacy-агента фиксирован: " + DefaultServerUrl);

            var serverUrl = DefaultServerUrl;

            var printers = InstalledPrinters();
            string printerName;
            if (printers.Count == 0)
            {
                Console.Write("Имя принтера (или file:C:\\labels для проверки): ");
                printerName = (Console.ReadLine() ?? "").Trim();
            }
            else
            {
                Console.WriteLine("\nУстановленные принтеры:");
                for (var i = 0; i < printers.Count; i++)
                {
                    Console.WriteLine("  " + (i + 1) + ". " + printers[i]);
                }
                Console.Write("\nНомер принтера (или впишите file:C:\\labels для проверки): ");
                var choice = (Console.ReadLine() ?? "").Trim();
                if (choice.StartsWith("file:", StringComparison.Ordinal))
                {
                    printerName = choice;
                }
                else
                {
                    int index;
                    if (!int.TryParse(choice, out index) || index < 1 || index > printers.Count)
                    {
                        throw new Exception("принтер не выбран");
                    }
                    printerName = printers[index - 1];
                }
            }

            Console.Write("Код подключения из настроек (Настройки → Печать): ");
            var code = (Console.ReadLine() ?? "").Trim();
            if (code.Length == 0)
            {
                throw new Exception("код подключения обязателен");
            }

            var paired = CallServer(serverUrl, "/api/print-agent/pair", new Dictionary<string, object>
            {
                { "code", code },
                { "computerName", Environment.MachineName },
                { "printerName", printerName }
            }, null);

            object tokenObj;
            if (!paired.TryGetValue("token", out tokenObj) || !(tokenObj is string))
            {
                throw new Exception("сервер не вернул токен подключения");
            }
            var token = (string)tokenObj;
            object pointName; paired.TryGetValue("pointName", out pointName);
            object pointId; paired.TryGetValue("pointId", out pointId);

            WriteConfig(new AgentConfig
            {
                serverUrl = serverUrl,
                printerName = printerName,
                pointId = pointId as string,
                token = ProtectToken(token)
            });

            Console.WriteLine("\nГотово. Точка печати: " + (pointName as string ?? "подключена"));
            Console.WriteLine("Настройки: " + ConfigPath + "\n");
        }

        // --- Рабочий цикл --------------------------------------------------------

        private static void RunLoop()
        {
            var config = ReadConfig();
            if (config == null)
            {
                throw new Exception("нет настроек: " + ConfigPath + ". Запустите с --setup.");
            }

            // Запасного подключения нет: адрес обязан быть именно app.erpget.ru.
            var host = new Uri(config.serverUrl).Host;
            if (!string.Equals(host, AllowedHost, StringComparison.OrdinalIgnoreCase))
            {
                throw new Exception("legacy-агент работает только с " + AllowedHost + ", а в настройках " + host + ".");
            }

            var token = UnprotectToken(config.token);
            var heartbeatMs = 30000;
            string lastError = null;
            var done = ProcessedJobs();

            // Незавершённое задание с прошлого запуска: компьютер выключили между
            // передачей спулеру и ответом серверу. Наклейка могла выйти —
            // сообщаем «исход неизвестен», второй раз не печатаем.
            var pending = ReadPendingJobId();
            if (!string.IsNullOrEmpty(pending))
            {
                Log("незавершённое задание " + pending + ": сообщаю «исход неизвестен»");
                try
                {
                    CallServer(config.serverUrl, "/api/print-agent/jobs/" + pending + "/result",
                        new Dictionary<string, object> { { "outcome", "unknown" } }, token);
                    ClearPending();
                }
                catch (Exception error)
                {
                    Log("  не удалось сообщить: " + error.Message);
                }
            }

            Log("агент запущен, принтер: " + config.printerName);

            while (true)
            {
                try
                {
                    var answer = CallServer(config.serverUrl, "/api/print-agent/poll",
                        new Dictionary<string, object> { { "error", lastError } }, token);
                    heartbeatMs = ReadInt(answer, "heartbeatMs", heartbeatMs);
                    lastError = null;

                    object jobObj;
                    answer.TryGetValue("job", out jobObj);
                    var job = jobObj as Dictionary<string, object>;
                    if (job == null)
                    {
                        Thread.Sleep(heartbeatMs);
                        continue;
                    }

                    object jobIdObj; job.TryGetValue("jobId", out jobIdObj);
                    var jobId = jobIdObj as string;
                    object kindObj; job.TryGetValue("kind", out kindObj);
                    var kind = kindObj as string ?? "";
                    var tspl = job.TryGetValue("tspl", out var tsplObj) ? tsplObj as string : null;

                    if (!string.IsNullOrEmpty(jobId) && done.Contains(jobId))
                    {
                        // Это задание уже печаталось на этом компьютере: сервер
                        // выдал его повторно после обрыва связи. Второй наклейки
                        // быть не должно.
                        Log("задание " + jobId + " уже печаталось: сообщаю «исход неизвестен»");
                        CallServer(config.serverUrl, "/api/print-agent/jobs/" + jobId + "/result",
                            new Dictionary<string, object> { { "outcome", "unknown" } }, token);
                        continue;
                    }

                    var bytes = Convert.FromBase64String(tspl ?? "");
                    Log("печать: " + kind + (jobId == null ? "" : " (" + jobId + ")") + ", " + bytes.Length + " байт");

                    if (!string.IsNullOrEmpty(jobId))
                    {
                        MarkPending(jobId);
                    }

                    try
                    {
                        SendToPrinter(config.printerName, bytes);
                        if (!string.IsNullOrEmpty(jobId))
                        {
                            RememberJob(jobId);
                            CallServer(config.serverUrl, "/api/print-agent/jobs/" + jobId + "/result",
                                new Dictionary<string, object> { { "outcome", "sent" } }, token);
                            ClearPending();
                        }
                        Log("  передано принтеру");
                    }
                    catch (Exception error)
                    {
                        // Спулер отказал — значит, ничего и не напечатал. Честный
                        // «failed»: сервер выдаст задание снова.
                        lastError = error.Message;
                        RememberError(error.Message);
                        Log("  ОШИБКА: " + error.Message);
                        if (!string.IsNullOrEmpty(jobId))
                        {
                            CallServer(config.serverUrl, "/api/print-agent/jobs/" + jobId + "/result",
                                new Dictionary<string, object> { { "outcome", "failed" } }, token);
                            ClearPending();
                        }
                    }
                }
                catch (Exception error)
                {
                    lastError = error.Message;
                    RememberError(error.Message);
                    Log("связь с сервером: " + error.Message);
                    Thread.Sleep(heartbeatMs);
                }
            }
        }

        private static int ReadInt(Dictionary<string, object> map, string key, int fallback)
        {
            object value;
            if (map != null && map.TryGetValue(key, out value) && value != null)
            {
                int parsed;
                if (int.TryParse(value.ToString(), out parsed))
                {
                    return parsed;
                }
            }
            return fallback;
        }
    }
}
