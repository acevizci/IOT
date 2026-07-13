package main

import "log"

// logf, tüm modüllerin ortak kullandığı basit bir log sarmalayıcısı.
func logf(format string, args ...interface{}) {
	log.Printf(format, args...)
}
