// MS2133 WebHID Flasher launcher. Serves embedded static assets on loopback only.
package main

import (
	"bytes"
	"context"
	"embed"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"syscall"
	"time"
)

//go:embed dist
var assets embed.FS

func existingUI(url string) bool {
	client := &http.Client{Timeout: 2 * time.Second}
	response, err := client.Get(url)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return false
	}
	if response.Header.Get("X-MS2133-UI") == "flasher-v1" {
		return true
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 65536))
	return err == nil && bytes.Contains(body, []byte("<title>MS2133 固件备份与恢复</title>"))
}

func openBrowser(url string) error {
	switch runtime.GOOS {
	case "darwin":
		for _, app := range []string{"Google Chrome", "Microsoft Edge", "Chromium"} {
			if err := exec.Command("open", "-a", app, url).Run(); err == nil {
				return nil
			}
		}
	case "windows":
		for _, base := range []string{os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)"), os.Getenv("LOCALAPPDATA")} {
			for _, relative := range []string{"Google/Chrome/Application/chrome.exe", "Microsoft/Edge/Application/msedge.exe"} {
				binary := filepath.Join(base, filepath.FromSlash(relative))
				if _, err := os.Stat(binary); err == nil {
					return exec.Command(binary, url).Start()
				}
			}
		}
	default:
		for _, binary := range []string{"google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"} {
			if path, err := exec.LookPath(binary); err == nil {
				return exec.Command(path, url).Start()
			}
		}
	}
	return fmt.Errorf("未找到桌面版 Chrome/Edge；请安装后手动打开 %s", url)
}

func main() {
	port := flag.Int("port", 17333, "localhost port; 0 chooses a free port")
	noBrowser := flag.Bool("no-browser", false, "do not open Chrome/Edge automatically")
	flag.Parse()
	listener, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(*port)))
	if err != nil {
		existingURL := "http://" + net.JoinHostPort("127.0.0.1", strconv.Itoa(*port)) + "/"
		if *port > 0 && existingUI(existingURL) {
			fmt.Printf("MS2133 工具已在运行：%s\n", existingURL)
			if !*noBrowser {
				if err := openBrowser(existingURL); err != nil {
					fmt.Fprintln(os.Stderr, err)
				}
			}
			return
		}
		log.Fatalf("启动失败：%v；可加 -port 17334 使用其他端口", err)
	}
	addr := listener.Addr().String()
	url := "http://" + addr + "/"
	root, err := fs.Sub(assets, "dist")
	if err != nil {
		log.Fatal(err)
	}
	static := http.FileServer(http.FS(root))
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != addr {
			http.Error(w, "invalid host", http.StatusForbidden)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-MS2133-UI", "flasher-v1")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Permissions-Policy", "hid=(self)")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
		static.ServeHTTP(w, r)
	})
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second}
	fmt.Printf("MS2133 固件备份与恢复\n%s\n仅本机静态网页服务；硬件通信由浏览器 WebHID 完成。\n按 Ctrl+C 退出。\n", url)
	if !*noBrowser {
		if err := openBrowser(url); err != nil {
			fmt.Fprintln(os.Stderr, err)
		}
	}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-stop
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
	}()
	if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
