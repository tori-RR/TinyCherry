package main

import (
	"errors"
	"testing"
	"time"
)

func TestStoreTransactionExecutorIsLocalAndRollbackIsolated(t *testing.T) {
	s, _ := testServer(t)
	ready, release := make(chan struct{}), make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- s.store.transaction(func(view *store) error {
			if s.store.tx != nil || view == s.store || view.tx == nil {
				return errors.New("transaction executor leaked into the shared store")
			}
			if err := view.setPreference(computerPreference, true); err != nil {
				return err
			}
			close(ready)
			<-release
			return errors.New("rollback fixture")
		})
	}()
	select {
	case <-ready:
	case err := <-done:
		t.Fatal(err)
	}
	read := make(chan any, 1)
	go func() {
		value, err := s.store.preference(computerPreference)
		if err != nil {
			read <- err
		} else {
			read <- value
		}
	}()
	select {
	case value := <-read:
		close(release)
		<-done
		t.Fatalf("outside read shared the uncommitted executor: %v", value)
	case <-time.After(40 * time.Millisecond):
	}
	close(release)
	if err := <-done; err == nil {
		t.Fatal("fixture transaction unexpectedly committed")
	}
	select {
	case value := <-read:
		if value != false {
			t.Fatalf("rollback leaked data: %v", value)
		}
	case <-time.After(time.Second):
		t.Fatal("outside read did not resume after rollback")
	}
	if s.store.tx != nil || s.store.preferenceUpdates != nil {
		t.Fatal("shared store retained transaction state")
	}
}
