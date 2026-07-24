package main

import "log"

func logf(format string, args ...interface{}) {
	log.Printf(format, args...)
}
